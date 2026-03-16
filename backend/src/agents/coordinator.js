import { groq, MODEL } from '../config.js';
import { worldState } from '../core/worldState.js';
import { eventQueue } from '../core/eventQueue.js';

import { ALL_TOOLS_SCHEMAS, executeTool } from '../tools/index.js';
import { runFirewall } from '../security/firewall.js';
import { logger } from '../utils/logger.js';
import { broadcast, broadcastToken, broadcastDecision } from '../utils/broadcast.js';
import { AuditEntry } from '../models/AuditEntry.js';
import { Incident } from '../models/Incident.js';

const MAX_REACT_ITERATIONS = 8;

// Human-readable descriptions for each tool call broadcasted to ThoughtTrace
const TOOL_THINKING = {
  getAvailableUnits:      (args) => `🔍 Checking available ${args.type || 'emergency'} units${args.zone ? ` in ${args.zone}` : ' across all zones'}...`,
  getRoute:               (args) => `📍 Calculating fastest route: ${args.origin} → ${args.destination}...`,
  blockRoad:              (args) => `🚧 Closing road edge ${args.edgeId} — ${args.reason || 'structural failure'}...`,
  dispatchUnit:           (args) => `🚀 Dispatching unit ${args.unitId} to zone ${args.destination}...`,
  returnUnit:             (args) => `↩️ Recalling unit ${args.unitId} back to base...`,
  getHospitalCapacity:    (args) => `🏥 Checking hospital bed availability${args.zone ? ` near ${args.zone}` : ''}...`,
  updateHospitalCapacity: (args) => `🏥 Updating hospital ${args.hospitalId} intake — ${args.availableBeds} beds remaining...`,
  getWeather:             (args) => `🌬️ Reading wind conditions in zone ${args.zone} — checking fire spread risk...`,
  notifyCitizens:         (args) => `📢 Broadcasting public alert to zone ${args.zone}: "${args.message?.slice(0, 50)}"...`,
};

const COORDINATOR_SYSTEM_PROMPT = `You are AEGIS — Autonomous Emergency Grid Intelligence System — the master coordinator for Delhi emergency response.

You coordinate Police, Fire, EMS, and Traffic agencies from a single unified command.

DELHI ZONES (2-3 letter codes):
- CP: Connaught Place (central business district)
- RP: Rajpath / India Gate (government zone)
- KB: Karol Bagh (dense commercial/residential)
- LN: Lajpat Nagar (south Delhi market)
- DW: Dwarka (southwest residential)
- RH: Rohini (north Delhi hub)
- SD: Shahdara (east Delhi — across Yamuna)
- NP: Nehru Place (IT hub)
- IGI: IGI Airport (southwest)
- OKH: Okhla (southeast industrial)

KEY INFRASTRUCTURE: e5 = Yamuna Bridge (CP↔SD) — the only direct central-east crossing.

YOUR DECISION PROTOCOL — follow EXACTLY:
1. Assess the incident: zone, type, severity, casualties
2. Call getAvailableUnits() to see what you have
3. Call getRoute() for each unit you plan to dispatch — confirm travel time
4. For fires: call getWeather() — wind direction determines fire spread
5. For casualties: call getHospitalCapacity() — route to best available hospital
6. Dispatch units with dispatchUnit() — be specific about which unit and why
7. Notify citizens if evacuation or road closure is needed
8. State your final decision clearly: what you dispatched, why, ETA

PRINCIPLES:
- Life safety over property over infrastructure
- Nearest appropriate unit, not just nearest unit — match specialty to incident
- Always dispatch a minimum viable response first, reserve units for escalation
- Transparency: explain every decision — judges and operators are watching your reasoning

You are live during a national emergency. Every decision is logged. Think clearly, act decisively.`;

// ─── Main coordinator loop ────────────────────────────────────────────────────

export async function startCoordinatorLoop() {
  logger.success('🧠 Coordinator loop started — waiting for events');
  while (true) {
    try {
      const event = await eventQueue.dequeue();
      await processEvent(event);
    } catch (err) {
      logger.error('Coordinator loop error:', err.message);
      await sleep(1000);
    }
  }
}

// ─── Process a single event ───────────────────────────────────────────────────

async function processEvent(event) {
  const incidentId = event.id;
  logger.agent('coordinator', `Processing: ${event.type} in ${event.zone} [P${event.priority}]`);

  // ── 0. Firewall ───────────────────────────────────────────────────────────
  const firewallResult = await runFirewall(event).catch(err => ({ passed: true, event }));
  if (!firewallResult || !firewallResult.passed) {
    logger.firewall('BLOCK', `Event ${incidentId} quarantined`);
    return;
  }

  // ── 1. Create incident ────────────────────────────────────────────────────
  const incident = worldState.createIncident({
    id: incidentId, type: event.type, subtype: event.subtype,
    zone: event.zone, priority: event.priority,
    description: event.description, metadata: event.metadata || event,
  });

  Incident.create({
    incidentId, type: event.type, subtype: event.subtype,
    zone: event.zone, priority: event.priority,
    description: event.description, metadata: event.metadata || event,
  }).catch(err => logger.error('Incident write failed:', err.message));

  broadcast({ type: 'INCIDENT_RECEIVED', payload: { ...incident } });

  // ── 2. Signal ThoughtTrace to open a new entry ────────────────────────────
  broadcast({
    type: 'THOUGHT_START',
    payload: { agentId: 'coordinator', incidentId, eventType: event.type, zone: event.zone },
  });

  // ── 3. Broadcast initial "thinking" status so panel isn't empty ───────────
  const eventLabel  = event.type.replace(/_/g, ' ');
  const sourceLabel = event._source === 'live_news' ? '[LIVE INCIDENT — News verified]'
                    : event._source === 'simulation_fallback' ? '[DRILL SIMULATION]'
                    : event._scenario ? '[DEMO SCENARIO]'
                    : '[INCIDENT]';
  const openingText =
    `${sourceLabel} INCIDENT ${incidentId}\n` +
    `Type: ${eventLabel.toUpperCase()} | Zone: ${event.zone} | Priority: ${event.priority}/10\n` +
    `${event._headline ? 'Source: "' + event._headline + '"\n' : ''}` +
    `Status: Analyzing city state and available resources...\n\n`;

  broadcastToken('coordinator', incidentId, openingText, false);

  // ── 4. Build message chain ────────────────────────────────────────────────
  const citySnapshot = worldState.getSnapshot();
  const messages = [
    { role: 'system', content: COORDINATOR_SYSTEM_PROMPT },
    { role: 'user',   content: buildUserMessage(event, citySnapshot) },
  ];

  // ── 5. ReAct loop ─────────────────────────────────────────────────────────
  let iterations    = 0;
  let fullReasoning = openingText;
  const toolCallLog = [];

  while (iterations < MAX_REACT_ITERATIONS) {
    iterations++;

    // Broadcast "step" label so user knows a new reasoning pass is starting
    if (iterations > 1) {
      const stepText = `\n[STEP ${iterations} — Reviewing tool results and deciding next action...]\n`;
      broadcastToken('coordinator', incidentId, stepText, false);
      fullReasoning += stepText;
    }

    // REASON — call Groq with streaming
    const { text, toolCalls } = await streamGroqCall(messages, incidentId);
    if (text) fullReasoning += text;

    // No tool calls = final decision reached
    if (toolCalls.length === 0) {
      if (!text) {
        // Model returned nothing — broadcast a fallback message
        const fallback = `\nAnalysis complete. Reviewing all dispatched units and active response.\n`;
        broadcastToken('coordinator', incidentId, fallback, false);
        fullReasoning += fallback;
      }
      logger.agent('coordinator', `Final decision after ${iterations} step(s)`);
      break;
    }

    // Append assistant message
    messages.push({ role: 'assistant', content: text || '', tool_calls: toolCalls });

    // ACT + OBSERVE — execute tools
    const toolResultMessages = [];

    for (const tc of toolCalls) {
      const toolName  = tc.function.name;
      let   parsedArgs;
      try { parsedArgs = JSON.parse(tc.function.arguments); } catch { parsedArgs = {}; }

      // Broadcast human-readable "what I'm doing now" before executing
      const thinkingMsg = TOOL_THINKING[toolName]
        ? TOOL_THINKING[toolName](parsedArgs)
        : `→ Calling ${toolName}...`;
      broadcastToken('coordinator', incidentId, `\n${thinkingMsg}`, false);
      fullReasoning += `\n${thinkingMsg}`;

      const { name, result } = await executeTool(toolName, tc.function.arguments);
      toolCallLog.push({ name, arguments: parsedArgs, result, step: iterations });

      // Broadcast the tool result summary
      const resultSummary = buildResultSummary(name, result, parsedArgs);
      broadcastToken('coordinator', incidentId, `\n${resultSummary}`, false);
      fullReasoning += `\n${resultSummary}`;

      broadcast({
        type: 'TOOL_EXECUTED',
        payload: { agentId: 'coordinator', incidentId, tool: name, args: parsedArgs, result },
      });

      toolResultMessages.push({
        role: 'tool', tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }

    messages.push(...toolResultMessages);
  }

  // ── 6. Extract and broadcast final decision ───────────────────────────────
  const finalDecision = extractFinalDecision(messages);

  // Append final decision to the stream so it's visible in ThoughtTrace
  const finalText = `\n\n[FINAL DECISION]\n${finalDecision}`;
  broadcastToken('coordinator', incidentId, finalText, false);

  broadcastDecision('coordinator', incidentId, fullReasoning, toolCallLog, finalDecision, event.type, event.zone);

  broadcast({
    type: 'THOUGHT_END',
    payload: { agentId: 'coordinator', incidentId, decision: finalDecision },
  });

  // ── 7. Update WorldState ──────────────────────────────────────────────────
  const dispatchedUnits = toolCallLog
    .filter(tc => tc.name === 'dispatchUnit' && tc.result?.success)
    .map(tc => tc.result.unit.id);

  if (dispatchedUnits.length > 0) {
    worldState.updateIncident(incidentId, { unitsDispatched: dispatchedUnits });
  }

  // ── 8. Persist to MongoDB ─────────────────────────────────────────────────
  AuditEntry.create({
    incidentId, agentType: 'coordinator',
    eventType: event.type, zone: event.zone, priority: event.priority,
    reasoning: fullReasoning, toolCalls: toolCallLog,
    decision: finalDecision, metadata: { iterations, dispatchedUnits },
  }).catch(err => logger.error('Audit write failed:', err.message));

  logger.agent('coordinator', `✅ Done in ${iterations} step(s). Dispatched: ${dispatchedUnits.length} unit(s)`);
}

// ─── Groq streaming call ──────────────────────────────────────────────────────

async function streamGroqCall(messages, incidentId) {
  let fullText = '';
  const toolCalls = [];

  try {
    // First iteration: force tool use so AI always checks units/routes
    // Subsequent iterations: auto lets AI decide when it has enough info
    const toolChoice = iterations === 1 ? 'required' : 'auto';
    const stream = await groq.chat.completions.create({
      model: MODEL, messages,
      tools: ALL_TOOLS_SCHEMAS, tool_choice: toolChoice,
      max_tokens: 1024, temperature: 0.1, stream: true,
    });

    const accumulator = {};

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        fullText += delta.content;
        broadcastToken('coordinator', incidentId, delta.content, false);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!accumulator[tc.index]) {
            accumulator[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          const acc = accumulator[tc.index];
          if (tc.id)                  acc.id                   = tc.id;
          if (tc.function?.name)      acc.function.name        = tc.function.name;
          if (tc.function?.arguments) acc.function.arguments  += tc.function.arguments;
        }
      }
    }

    Object.values(accumulator).forEach(tc => toolCalls.push(tc));
    broadcastToken('coordinator', incidentId, '', true);

  } catch (err) {
    logger.error('Groq error:', err.message);
    broadcastToken('coordinator', incidentId, `\n❌ Groq API error: ${err.message}`, true);
    broadcast({ type: 'COORDINATOR_ERROR', payload: { incidentId, error: err.message } });
  }

  return { text: fullText, toolCalls };
}

// ─── Result summary builder ───────────────────────────────────────────────────

function buildResultSummary(toolName, result, args) {
  if (!result.success && result.success !== undefined) {
    return `  ⚠️  Failed: ${result.error || 'unknown error'}`;
  }
  switch (toolName) {
    case 'getAvailableUnits':
      return `  ✓ Found ${result.totalAvailable} available units (Police:${result.summary?.police} Fire:${result.summary?.fire} EMS:${result.summary?.ems} Traffic:${result.summary?.traffic})`;
    case 'getRoute':
      return result.success
        ? `  ✓ Route found: ${result.pathNames?.join(' → ')} — ETA ${result.totalTimeMinutes} min`
        : `  ✗ No route: ${result.error}`;
    case 'blockRoad':
      return `  ✓ ${result.edgeName || args.edgeId} is now BLOCKED — all routing rerouted`;
    case 'dispatchUnit':
      return `  ✓ ${result.unit?.callSign || args.unitId} dispatched → ${args.destination}`;
    case 'returnUnit':
      return `  ✓ ${result.unit?.name || args.unitId} returned to available`;
    case 'getHospitalCapacity':
      return `  ✓ ${result.recommendation || `${result.totalAvailableBeds} beds available across ${result.totalQueried} hospitals`}`;
    case 'updateHospitalCapacity':
      return `  ✓ ${result.hospital?.name || args.hospitalId} updated: ${result.hospital?.availableBeds} beds remaining`;
    case 'getWeather':
      return `  ✓ Zone ${args.zone}: Wind ${result.weather?.windSpeed}km/h ${result.weather?.windDirection} — Fire spread risk: ${result.weather?.fireSpreadRisk}`;
    case 'notifyCitizens':
      return `  ✓ Alert broadcast to zone ${args.zone} [${args.severity?.toUpperCase()}]`;
    default:
      return `  ✓ ${toolName} completed`;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildUserMessage(event, snapshot) {
  const stats     = snapshot.stats;
  const unitsAvail = snapshot.units.filter(u => u.status === 'available');
  const activeInc  = snapshot.activeIncidents.filter(i => i.id !== event.id);

  return `INCOMING EMERGENCY — IMMEDIATE RESPONSE REQUIRED

INCIDENT:
  Type:        ${event.type}${event.subtype ? `/${event.subtype}` : ''}
  Zone:        ${event.zone}
  Priority:    ${event.priority}/10
  Description: ${event.description}
  ID:          ${event.id}

CURRENT CITY STATE:
  Available units: ${stats.availableUnits}/${stats.totalUnits}
    Police:  ${unitsAvail.filter(u=>u.type==='police').length}
    Fire:    ${unitsAvail.filter(u=>u.type==='fire').length}
    EMS:     ${unitsAvail.filter(u=>u.type==='ems').length}
    Traffic: ${unitsAvail.filter(u=>u.type==='traffic').length}
  Blocked roads: ${stats.blockedRoads > 0 ? snapshot.blockedEdges.join(', ') : 'none'}
  Other active incidents: ${activeInc.length > 0 ? activeInc.map(i=>`${i.type} in ${i.zone} (P${i.priority})`).join('; ') : 'none'}

Begin your assessment and coordinate the response now.`;
}

function extractFinalDecision(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.content?.trim()) {
      return msg.content.trim();
    }
  }
  return 'Response coordinated. See tool execution chain above for dispatched units and routes.';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }