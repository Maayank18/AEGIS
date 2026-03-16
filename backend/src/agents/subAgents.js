import { groq, MODEL } from '../config.js';
import { worldState } from '../core/worldState.js';
import { executeTool } from '../tools/index.js';
import { POLICE_TOOLS, FIRE_TOOLS, EMS_TOOLS, TRAFFIC_TOOLS, COMMS_TOOLS } from '../tools/index.js';
import { logger } from '../utils/logger.js';
import { broadcast, broadcastToken } from '../utils/broadcast.js';
import { AuditEntry } from '../models/AuditEntry.js';

// ─── Sub-Agents ───────────────────────────────────────────────────────────────
// Each sub-agent has a focused system prompt and a restricted tool subset.
// The coordinator calls them via runSubAgent() for domain-specific decisions.
// Sub-agents do ONE Groq call (with streaming) — no nested ReAct loop.
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_CONFIGS = {
  police: {
    name:   'Police Command',
    color:  '🔵',
    tools:  POLICE_TOOLS,
    system: `You are the Delhi Police Command sub-agent for AEGIS.
Your domain: law enforcement, crowd control, crime response, perimeter security, traffic offence management.

RESPONSE PROTOCOL:
1. Assess threat level and required police presence
2. Get available police units (getAvailableUnits with type="police")
3. Get route for nearest unit (getRoute)
4. Dispatch — always use patrol units for general response, rapid response (P-4 Bravo-1) for riot/mass events
5. Set up perimeter if needed — dispatch 2 units minimum for high-priority incidents
6. Notify citizens if evacuation or lockdown is required

Be decisive. Give exact unit IDs, ETAs, and tactical reasoning.`,
  },

  fire: {
    name:   'Fire Command',
    color:  '🔴',
    tools:  FIRE_TOOLS,
    system: `You are the Delhi Fire Command sub-agent for AEGIS.
Your domain: structural fires, hazmat incidents, vehicle fires, fire suppression, rescue operations.

RESPONSE PROTOCOL:
1. Immediately call getWeather() for the incident zone — wind direction determines fire spread
2. Get available fire units — prefer specialty match (Hazmat-1 for chemical, Flame units for structural)
3. Route the closest fire unit first
4. For HIGH/EXTREME fire spread risk: pre-position a second unit in the DOWNWIND zone
5. Dispatch with specific instructions about wind conditions and spread direction
6. If hazmat is involved: ONLY dispatch Hazmat-1 (F-2) — standard units lack protective equipment

Wind direction is critical. A fire in KB with NW winds WILL spread SE — position accordingly.`,
  },

  ems: {
    name:   'EMS Command',
    color:  '🟢',
    tools:  EMS_TOOLS,
    system: `You are the Delhi EMS Command sub-agent for AEGIS.
Your domain: medical emergencies, casualty transport, mass casualty triage, hospital coordination.

RESPONSE PROTOCOL:
1. Assess casualty count and injury severity from incident description
2. Get available EMS units — ALS (Medic-2, E-2) for cardiac/critical; BLS (Medic-1/3/4) for general trauma
3. Call getHospitalCapacity() — always before routing casualties
4. Route the closest appropriate unit
5. For mass casualty (3+ patients): dispatch multiple units, split patients across hospitals
6. After determining hospital: call updateHospitalCapacity() to decrement bed count

ALS vs BLS:
- Cardiac, stroke, respiratory failure, unconscious → ALS (Medic-2 only)
- Trauma, fractures, lacerations, burns → any BLS unit

Never overload a single hospital. Distribute casualties to preserve system-wide capacity.`,
  },

  traffic: {
    name:   'Traffic Control',
    color:  '🟡',
    tools:  TRAFFIC_TOOLS,
    system: `You are the Delhi Traffic Control sub-agent for AEGIS.
Your domain: signal management, road closures, bridge monitoring, evacuation corridor establishment, accident scene management.

RESPONSE PROTOCOL:
1. Assess traffic impact: which roads/zones are affected?
2. For bridge/road collapse: immediately call blockRoad() with the correct edge ID
   (Yamuna Bridge = edge e5, connects CP and SD)
3. Dispatch traffic units to affected zones for manual signal override
4. Create evacuation corridors — identify alternative routes using getRoute()
5. Notify citizens about road closures and recommended detours

CRITICAL: After blockRoad(), all routing in AEGIS automatically reroutes — inform all active units.
e5 = Yamuna Bridge (CP↔SD) — blocking this cuts off Shahdara from central Delhi.`,
  },

  comms: {
    name:   'Citizen Comms',
    color:  '🟣',
    tools:  COMMS_TOOLS,
    system: `You are the Delhi Citizen Communications sub-agent for AEGIS.
Your domain: public alerts, evacuation notices, safety advisories, shelter-in-place orders.

RESPONSE PROTOCOL:
1. Identify affected zones — primary zone + adjacent zones for large incidents
2. Craft clear, actionable alert messages — under 90 characters, plain language
3. Match severity to incident: low=advisory, medium=warning, high=evacuation advisory, critical=mandatory evacuation
4. Send alerts to ALL affected zones — don't just alert the primary zone
5. Include specific action (Evacuate now / Shelter in place / Avoid area / Call emergency services)

Alert format: [ACTION]: [SPECIFIC INSTRUCTION]. Example: "EVACUATE: KB sector fire spreading SE. Use NH-9 westbound exit."`,
  },
};

/**
 * Run a sub-agent for a specific agency and incident.
 * @param {string} agentType - 'police' | 'fire' | 'ems' | 'traffic' | 'comms'
 * @param {object} incident  - The incident object from WorldState
 * @param {string} directive - Additional instruction from the coordinator
 */
export async function runSubAgent(agentType, incident, directive = '') {
  const config = AGENT_CONFIGS[agentType];
  if (!config) throw new Error(`Unknown sub-agent type: ${agentType}`);

  const incidentId = incident.id;
  logger.agent(agentType, `${config.color} Sub-agent activated for incident ${incidentId}`);

  broadcast({
    type: 'SUBAGENT_START',
    payload: { agentId: agentType, incidentId, agentName: config.name },
  });

  const snapshot    = worldState.getSnapshot();
  const userMessage = buildSubAgentMessage(incident, snapshot, directive);

  const messages = [
    { role: 'system', content: config.system },
    { role: 'user',   content: userMessage },
  ];

  let fullText  = '';
  const toolLog = [];

  // One streaming Groq call per sub-agent
  const toolCallAccumulator = {};

  const stream = await groq.chat.completions.create({
    model:       MODEL,
    messages,
    tools:       config.tools,
    tool_choice: 'auto',
    max_tokens:  512,
    temperature: 0.1,
    stream:      true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      fullText += delta.content;
      broadcastToken(agentType, incidentId, delta.content, false);
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!toolCallAccumulator[tc.index]) {
          toolCallAccumulator[tc.index] = {
            id: tc.id || '',
            function: { name: tc.function?.name || '', arguments: '' },
          };
        }
        const acc = toolCallAccumulator[tc.index];
        if (tc.id)                  acc.id                   = tc.id;
        if (tc.function?.name)      acc.function.name        = tc.function.name;
        if (tc.function?.arguments) acc.function.arguments  += tc.function.arguments;
      }
    }
  }

  broadcastToken(agentType, incidentId, '', true);

  // Execute all tool calls
  const toolCalls = Object.values(toolCallAccumulator);

  for (const tc of toolCalls) {
    const { name, parsedArgs, result } = await executeTool(tc.function.name, tc.function.arguments);
    toolLog.push({ name, arguments: parsedArgs, result });

    broadcast({
      type: 'TOOL_EXECUTED',
      payload: { agentId: agentType, incidentId, tool: name, args: parsedArgs, result },
    });
  }

  broadcast({
    type: 'SUBAGENT_COMPLETE',
    payload: { agentId: agentType, incidentId, reasoning: fullText, toolCalls: toolLog },
  });

  AuditEntry.create({
    incidentId,
    agentType,
    eventType: incident.type,
    zone:      incident.zone,
    priority:  incident.priority,
    reasoning: fullText,
    toolCalls: toolLog,
    decision:  fullText.slice(0, 300),
  }).catch(err => logger.error(`${agentType} audit write failed:`, err.message));

  logger.agent(agentType, `${config.color} Sub-agent complete — ${toolLog.length} tool(s) executed`);
  return { agentType, reasoning: fullText, toolCalls: toolLog };
}

function buildSubAgentMessage(incident, snapshot, directive) {
  const relevant = snapshot.units.filter(
    u => u.type === incident.type || u.status === 'available'
  );

  return `INCIDENT BRIEFING:
Type:        ${incident.type}${incident.subtype ? `/${incident.subtype}` : ''}
Zone:        ${incident.zone}
Priority:    ${incident.priority}/10
Description: ${incident.description}
Incident ID: ${incident.id}

AVAILABLE UNITS (all types):
${snapshot.units
    .filter(u => u.status === 'available')
    .map(u => `  ${u.id}: ${u.name} (${u.type}) at zone ${u.currentZone}`)
    .join('\n') || '  None available'}

BLOCKED ROADS: ${snapshot.blockedEdges.length > 0 ? snapshot.blockedEdges.join(', ') : 'None'}

${directive ? `COORDINATOR DIRECTIVE: ${directive}` : ''}

Respond and act now.`;
}