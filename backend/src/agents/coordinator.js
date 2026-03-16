import { groq, MODEL } from '../config.js';
import { worldState } from '../core/worldState.js';
import { eventQueue } from '../core/eventQueue.js';
import { ALL_TOOLS_SCHEMAS, executeTool } from '../tools/index.js';
import { runFirewall } from '../security/firewall.js';
import { logger } from '../utils/logger.js';
import { broadcast, broadcastToken, broadcastDecision } from '../utils/broadcast.js';
import { AuditEntry } from '../models/AuditEntry.js';
import { Incident } from '../models/Incident.js';


// ─── Error rate tracker ───────────────────────────────────────────────────────
// Counts failures per minute. Warns if >2 failures/min (sign of API issues).
const _errorTracker = {
  _timestamps: [],
  record(msg) {
    const now = Date.now();
    this._timestamps.push(now);
    // Keep only last 60 seconds
    this._timestamps = this._timestamps.filter(t => now - t < 60_000);
    if (this._timestamps.length >= 2) {
      logger.warn(`⚠ ${this._timestamps.length} Groq errors in last 60s — check API key or quota`);
    }
  },
  rate() { return this._timestamps.filter(t => Date.now() - t < 60_000).length; },
};

const MAX_REACT_ITERATIONS = 3; // 3 steps is enough: check → route → dispatch

// Human-readable tool descriptions for ThoughtTrace
const TOOL_THINKING = {
  getAvailableUnits:      (a) => `🔍 Checking available ${a.type || 'emergency'} units${a.zone ? ' in ' + a.zone : ''}...`,
  getRoute:               (a) => `📍 Calculating fastest route: ${a.origin} → ${a.destination}...`,
  blockRoad:              (a) => `🚧 Closing road edge ${a.edgeId} — ${a.reason || 'structural failure'}...`,
  dispatchUnit:           (a) => `🚀 Dispatching unit ${a.unitId} to zone ${a.destination}...`,
  returnUnit:             (a) => `↩️  Recalling unit ${a.unitId} back to base...`,
  getHospitalCapacity:    (a) => `🏥 Checking hospital beds${a.zone ? ' near ' + a.zone : ''}...`,
  updateHospitalCapacity: (a) => `🏥 Updating hospital ${a.hospitalId} intake...`,
  getWeather:             (a) => `🌬️  Reading wind & fire spread data for zone ${a.zone}...`,
  notifyCitizens:         (a) => `📢 Broadcasting public alert to zone ${a.zone}...`,
};

const COORDINATOR_SYSTEM_PROMPT = `You are AEGIS — the AI emergency coordinator for Delhi.

ALWAYS begin your response by calling getAvailableUnits() first — no exceptions.
Then call getRoute() for each unit you plan to dispatch.
Then call dispatchUnit() for each chosen unit.
For fires: also call getWeather() to check wind direction.
For casualties: call getHospitalCapacity() before routing patients.

DELHI ZONES: CP=Connaught Place, RP=Rajpath, KB=Karol Bagh, LN=Lajpat Nagar,
DW=Dwarka, RH=Rohini, SD=Shahdara, NP=Nehru Place, IGI=Airport, OKH=Okhla
Yamuna Bridge = edge e5 (CP↔SD)

DECISION PRIORITY: Life safety > property > infrastructure
Match unit specialty to incident type. Dispatch minimum viable response first.
Every decision is logged. Be decisive and specific.`;

// ─── Main loop ────────────────────────────────────────────────────────────────

export async function startCoordinatorLoop() {
  logger.success('🧠 Coordinator loop started');
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

async function processEvent(event) {
  const incidentId = event.id;
  logger.agent('coordinator', `Processing: ${event.type} in ${event.zone} [P${event.priority}]`);

  // ── Firewall ──────────────────────────────────────────────────────────────
  const fw = await runFirewall(event).catch(() => ({ passed: true, event }));
  if (!fw || !fw.passed) {
    logger.firewall('BLOCK', `Event ${incidentId} quarantined`);
    return;
  }

  // ── Create incident ───────────────────────────────────────────────────────
  const incident = worldState.createIncident({
    id: incidentId, type: event.type, subtype: event.subtype,
    zone: event.zone, priority: event.priority,
    description: event.description, metadata: event.metadata || event,
  });

  Incident.create({
    incidentId, type: event.type, subtype: event.subtype,
    zone: event.zone, priority: event.priority,
    description: event.description, metadata: event,
  }).catch(() => {});

  broadcast({ type: 'INCIDENT_RECEIVED', payload: { ...incident } });

  // ── Open ThoughtTrace entry ───────────────────────────────────────────────
  broadcast({ type: 'THOUGHT_START', payload: { agentId: 'coordinator', incidentId, eventType: event.type, zone: event.zone } });

  const sourceLabel = event._source === 'live_news' ? '[LIVE NEWS]'
                    : event._source === 'simulation_fallback' ? '[SIMULATION]'
                    : event._scenario ? '[DEMO]' : '[INCIDENT]';

  const openingText =
    `${sourceLabel} ${event.type.replace(/_/g,' ').toUpperCase()} in ${event.zone} — Priority ${event.priority}/10\n` +
    `${event._headline ? 'Source: "' + event._headline + '"\n' : ''}` +
    `Analyzing city state...\n\n`;

  broadcastToken('coordinator', incidentId, openingText, false);

  // ── Build messages ────────────────────────────────────────────────────────
  const snapshot = worldState.getSnapshot();
  const messages = [
    { role: 'system', content: COORDINATOR_SYSTEM_PROMPT },
    { role: 'user',   content: buildUserMessage(event, snapshot) },
  ];

  let fullReasoning = openingText;
  const toolCallLog = [];

  // ── STEP 1: Non-streaming forced tool call (guarantees tools execute) ─────
  // We do this as a regular (non-streaming) call first so tool calls are
  // guaranteed to be returned. Streaming is unreliable for tool use with some
  // Groq SDK versions — it sometimes returns empty delta.tool_calls arrays.
  try {
    const firstResponse = await groq.chat.completions.create({
      model: MODEL, messages,
      tools: ALL_TOOLS_SCHEMAS,
      tool_choice: 'required',   // FORCE at least one tool call
      max_tokens: 200,
      temperature: 0.1,
      stream: false,             // NON-streaming for reliability
    });

    const firstMsg   = firstResponse.choices[0].message;
    const firstTools = firstMsg.tool_calls || [];

    if (firstTools.length === 0) {
      // Groq refused to call a tool even with required — rare but handle gracefully
      logger.warn('Groq returned 0 tools even with required — using text response');
      const fallbackText = firstMsg.content || 'Assessed incident. Monitoring situation.';
      broadcastToken('coordinator', incidentId, fallbackText, false);
      fullReasoning += fallbackText;
      messages.push({ role: 'assistant', content: fallbackText });
    } else {
      // Execute all tools from first response
      if (firstMsg.content) {
        broadcastToken('coordinator', incidentId, firstMsg.content, false);
        fullReasoning += firstMsg.content;
      }

      messages.push({ role: 'assistant', content: firstMsg.content || '', tool_calls: firstTools });

      const toolResultMessages = [];
      for (const tc of firstTools) {
        const toolName  = tc.function.name;
        let   parsedArgs;
        try { parsedArgs = JSON.parse(tc.function.arguments); } catch { parsedArgs = {}; }

        const thinkingMsg = TOOL_THINKING[toolName] ? TOOL_THINKING[toolName](parsedArgs) : `→ ${toolName}...`;
        broadcastToken('coordinator', incidentId, `\n${thinkingMsg}`, false);

        const { name, result } = await executeTool(toolName, tc.function.arguments);
        toolCallLog.push({ name, arguments: parsedArgs, result, step: 1 });

        const summary = buildResultSummary(name, result, parsedArgs);
        broadcastToken('coordinator', incidentId, `\n${summary}`, false);
        fullReasoning += `\n${thinkingMsg}\n${summary}`;

        broadcast({ type: 'TOOL_EXECUTED', payload: { agentId: 'coordinator', incidentId, tool: name, args: parsedArgs, result } });

        // When a unit is dispatched, broadcast its route for the live map
        if (name === 'dispatchUnit' && result?.success) {
          const matchingRoute = [...toolCallLog].reverse().find(t =>
            t.name === 'getRoute' && t.result?.success && t.result?.path
          );
          if (matchingRoute) {
            broadcast({
              type: 'UNIT_ROUTE',
              payload: {
                unitId:      result.unit.id,
                unitType:    result.unit.type,
                unitName:    result.unit.name,
                path:        matchingRoute.result.path,
                origin:      matchingRoute.result.path[0],
                destination: matchingRoute.result.path[matchingRoute.result.path.length - 1],
                etaMinutes:  matchingRoute.result.totalTimeMinutes,
                incidentId,
              },
            });
          }
        }

        toolResultMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(trimForContext(name, result)) });
      }
      messages.push(...toolResultMessages);
    }
  } catch (err) {
    if (err.status === 429 || err.message?.includes('429') || err.message?.includes('rate limit')) {
      logger.warn('⚠ Groq rate limit hit — pausing 60s then re-queuing event');
      broadcastToken('coordinator', incidentId, '\n⚠ Rate limit reached — event will retry in 60 seconds\n', true);
      await sleep(60_000);
      eventQueue.enqueue(event); // re-queue so it gets processed after pause
      return;
    }
    _errorTracker.record(err.message);
    logger.error('First Groq call failed:', err.message);
    broadcastToken('coordinator', incidentId, `\nError contacting AI: ${err.message}\n`, false);
  }

  // ── STEPS 2-N: Streaming continuation for remaining reasoning ─────────────
  let iterations = 1;
  while (iterations < MAX_REACT_ITERATIONS) {
    iterations++;

    const stepText = `\n[Step ${iterations} — Continuing coordination...]\n`;
    broadcastToken('coordinator', incidentId, stepText, false);
    fullReasoning += stepText;

    const { text, toolCalls } = await streamGroqCall(messages, incidentId);
    if (text) fullReasoning += text;

    if (toolCalls.length === 0) {
      logger.agent('coordinator', `Coordination complete after ${iterations} step(s)`);
      break;
    }

    messages.push({ role: 'assistant', content: text || '', tool_calls: toolCalls });

    const toolResultMessages = [];
    for (const tc of toolCalls) {
      const toolName = tc.function.name;
      let parsedArgs;
      try { parsedArgs = JSON.parse(tc.function.arguments); } catch { parsedArgs = {}; }

      const thinkingMsg = TOOL_THINKING[toolName] ? TOOL_THINKING[toolName](parsedArgs) : `→ ${toolName}...`;
      broadcastToken('coordinator', incidentId, `\n${thinkingMsg}`, false);

      const { name, result } = await executeTool(toolName, tc.function.arguments);
      toolCallLog.push({ name, arguments: parsedArgs, result, step: iterations });

      const summary = buildResultSummary(name, result, parsedArgs);
      broadcastToken('coordinator', incidentId, `\n${summary}`, false);
      fullReasoning += `\n${thinkingMsg}\n${summary}`;

      broadcast({ type: 'TOOL_EXECUTED', payload: { agentId: 'coordinator', incidentId, tool: name, args: parsedArgs, result } });

      // Broadcast route for live map when unit dispatched
      if (name === 'dispatchUnit' && result?.success) {
        const matchingRoute = [...toolCallLog].reverse().find(t =>
          t.name === 'getRoute' && t.result?.success && t.result?.path
        );
        if (matchingRoute) {
          broadcast({
            type: 'UNIT_ROUTE',
            payload: {
              unitId:      result.unit.id,
              unitType:    result.unit.type,
              unitName:    result.unit.name,
              path:        matchingRoute.result.path,
              origin:      matchingRoute.result.path[0],
              destination: matchingRoute.result.path[matchingRoute.result.path.length - 1],
              etaMinutes:  matchingRoute.result.totalTimeMinutes,
              incidentId,
            },
          });
        }
      }

      toolResultMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(trimForContext(name, result)) });
    }
    messages.push(...toolResultMessages);
  }

  // ── Final decision ────────────────────────────────────────────────────────
  const finalDecision = extractFinalDecision(messages) || buildAutoSummary(toolCallLog, event);
  const finalText = `\n\n[DECISION]\n${finalDecision}`;
  broadcastToken('coordinator', incidentId, finalText, false);

  // Broadcast decision — this is what populates the Decision Log
  broadcastDecision('coordinator', incidentId, fullReasoning, toolCallLog, finalDecision, event.type, event.zone);

  broadcast({ type: 'THOUGHT_END', payload: { agentId: 'coordinator', incidentId, decision: finalDecision } });

  // ── Update WorldState ─────────────────────────────────────────────────────
  const dispatched = toolCallLog
    .filter(tc => tc.name === 'dispatchUnit' && tc.result?.success)
    .map(tc => tc.result.unit.id);

  if (dispatched.length > 0) worldState.updateIncident(incidentId, { unitsDispatched: dispatched });

  // ── Persist to MongoDB ────────────────────────────────────────────────────
  AuditEntry.create({
    incidentId, agentType: 'coordinator',
    eventType: event.type, zone: event.zone, priority: event.priority,
    reasoning: fullReasoning, toolCalls: toolCallLog,
    decision: finalDecision, metadata: { iterations, dispatched },
  }).catch(() => {});

  logger.agent('coordinator', `✅ Done in ${iterations} steps. Dispatched: ${dispatched.length} unit(s). Tools used: ${toolCallLog.length}`);
}

// ─── Streaming Groq call (for steps 2+) ──────────────────────────────────────

// Continuation schemas — only 3 most-needed tools for steps 2+
// (model already called getAvailableUnits in step 1, no need to offer all 9 tools again)
const CONTINUATION_SCHEMAS = ALL_TOOLS_SCHEMAS.filter(t =>
  ['getRoute', 'dispatchUnit', 'notifyCitizens', 'getHospitalCapacity', 'blockRoad', 'getWeather'].includes(t.function.name)
);

async function streamGroqCall(messages, incidentId) {
  let fullText = '';
  const toolCalls = [];

  try {
    const stream = await groq.chat.completions.create({
      model: MODEL, messages,
      tools: CONTINUATION_SCHEMAS, tool_choice: 'auto',
      max_tokens: 300, temperature: 0.1, stream: true,
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
          const a = accumulator[tc.index];
          if (tc.id)                  a.id                   = tc.id;
          if (tc.function?.name)      a.function.name        = tc.function.name;
          if (tc.function?.arguments) a.function.arguments  += tc.function.arguments;
        }
      }
    }

    Object.values(accumulator).forEach(tc => toolCalls.push(tc));
    // NOTE: do NOT send done:true here — only THOUGHT_END (line ~286) archives the thought.
    // Sending done:true here would close the active card mid-reasoning if there are multiple steps.

  } catch (err) {
    if (err.status === 429 || err.message?.includes('429') || err.message?.includes('rate limit')) {
      logger.warn('⚠ Groq rate limit (streaming) — pausing 60s');
      broadcastToken('coordinator', incidentId, '\n⚠ Rate limit — pausing...', true);
      await sleep(60_000);
      return { text: '', toolCalls: [] }; // graceful empty — loop will break naturally
    }
    _errorTracker.record(err.message);
    logger.error('Groq streaming error:', err.message);
    broadcastToken('coordinator', incidentId, `\n⚠ AI error: ${err.message}`, false);
  }

  return { text: fullText, toolCalls };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Trim tool results for message context ────────────────────────────────────
// Full results go to toolCallLog (for UI). Context only gets lean version.
// Prevents getAvailableUnits/hospital results from bloating the messages array.
function trimForContext(toolName, result) {
  if (!result || result.success === false) return result;
  switch (toolName) {
    case 'getAvailableUnits':
      return {
        success: true,
        totalAvailable: result.totalAvailable,
        summary: result.summary,
        units: (result.units || []).map(u => ({
          id: u.id, name: u.name, type: u.type, currentZone: u.currentZone,
        })),
        note: result.note,
      };
    case 'getHospitalCapacity':
      return {
        success: true,
        recommendation: result.recommendation,
        totalAvailableBeds: result.totalAvailableBeds,
        totalAvailableIcu: result.totalAvailableIcu,
        hospitals: (result.hospitals || []).slice(0, 3).map(h => ({
          id: h.id, name: h.name, zone: h.zone,
          availableBeds: h.availableBeds, availableIcu: h.availableIcu, status: h.status,
        })),
      };
    case 'getRoute':
      return {
        success: result.success,
        path: result.path,
        totalTimeMinutes: result.totalTimeMinutes,
        error: result.error,
        suggestion: result.suggestion,
      };
    default:
      return result;
  }
}


function buildResultSummary(toolName, result, args) {
  if (result.success === false) return `  ✗ Failed: ${result.error || 'unknown error'}`;
  switch (toolName) {
    case 'getAvailableUnits':
      return `  ✓ ${result.totalAvailable} units available (P:${result.summary?.police} F:${result.summary?.fire} E:${result.summary?.ems} T:${result.summary?.traffic})`;
    case 'getRoute':
      return result.success
        ? `  ✓ Route: ${result.pathNames?.join(' → ')} — ETA ${result.totalTimeMinutes} min`
        : `  ✗ No route: ${result.error}`;
    case 'blockRoad':
      return `  ✓ ${result.edgeName || args.edgeId} CLOSED — all routing rerouted`;
    case 'dispatchUnit':
      return `  ✓ ${result.unit?.callSign || args.unitId} → ${args.destination}`;
    case 'returnUnit':
      return `  ✓ ${result.unit?.name || args.unitId} returned to base`;
    case 'getHospitalCapacity':
      return `  ✓ ${result.recommendation || result.totalAvailableBeds + ' beds available'}`;
    case 'getWeather':
      return `  ✓ Wind: ${result.weather?.windSpeed}km/h ${result.weather?.windDirection} — Fire spread: ${result.weather?.fireSpreadRisk}`;
    case 'notifyCitizens':
      return `  ✓ Alert sent to zone ${args.zone} [${(args.severity || 'high').toUpperCase()}]`;
    default:
      return `  ✓ ${toolName} completed`;
  }
}

function buildAutoSummary(toolCallLog, event) {
  const dispatched = toolCallLog.filter(tc => tc.name === 'dispatchUnit' && tc.result?.success);
  const blocked    = toolCallLog.filter(tc => tc.name === 'blockRoad'     && tc.result?.success);

  if (dispatched.length === 0 && blocked.length === 0) {
    return `Assessed ${event.type.replace(/_/g,' ')} in ${event.zone}. All units currently allocated to active incidents. Monitoring situation — will dispatch when capacity available.`;
  }

  const lines = [];
  if (blocked.length > 0) lines.push(`Closed ${blocked.length} road(s). All routing rerouted automatically.`);
  if (dispatched.length > 0) {
    const names = dispatched.map(d => d.result?.unit?.name || d.arguments?.unitId).join(', ');
    lines.push(`Dispatched ${dispatched.length} unit(s): ${names}.`);
  }
  return lines.join(' ');
}

function buildUserMessage(event, snapshot) {
  const stats  = snapshot.stats;
  const avail  = snapshot.units.filter(u => u.status === 'available');
  const active = snapshot.activeIncidents.filter(i => i.id !== event.id);

  return `EMERGENCY REQUIRING IMMEDIATE RESPONSE:

Type: ${event.type}${event.subtype ? '/' + event.subtype : ''}
Zone: ${event.zone}
Priority: ${event.priority}/10
Description: ${(event.description || '').slice(0, 120)}
ID: ${event.id}

CITY STATE:
Available units: ${stats.availableUnits}/${stats.totalUnits}
  Police: ${avail.filter(u=>u.type==='police').length}
  Fire:   ${avail.filter(u=>u.type==='fire').length}
  EMS:    ${avail.filter(u=>u.type==='ems').length}
  Traffic:${avail.filter(u=>u.type==='traffic').length}
Blocked roads: ${stats.blockedRoads > 0 ? snapshot.blockedEdges.join(', ') : 'none'}
Other active: ${active.length > 0 ? active.map(i=>`${i.type} in ${i.zone}`).join('; ') : 'none'}

Call getAvailableUnits() first, then coordinate your response.`;
}

function extractFinalDecision(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.content?.trim()) return m.content.trim();
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }