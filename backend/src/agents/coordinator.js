/*
 * Why changed: normalize route broadcasts, capture tool results explicitly, and add light demo pacing so live panels remain visible a little longer.
 * Security rationale: firewall still gates every event before action, and pacing only delays broadcasts around existing decisions instead of altering any dispatch logic.
 */
import { DEMO_PACING, genAI, GEMINI_SAFETY_SETTINGS, MODEL_LIMITS, MODEL_NAME } from '../config.js';
import { worldState } from '../core/worldState.js';
import { eventQueue } from '../core/eventQueue.js';
import { ALL_TOOLS_SCHEMAS, executeTool } from '../tools/index.js';
import { runFirewall } from '../security/firewall.js';
import { logger } from '../utils/logger.js';
import { broadcast, broadcastDecision, broadcastToken } from '../utils/broadcast.js';
import { AuditEntry } from '../models/AuditEntry.js';
import { Incident } from '../models/Incident.js';

const MAX_REACT_ITERATIONS = 3;
const _processingIds = new Set();
const _consecutiveFailures = { count: 0, lastFailAt: 0 };
const DEGRADED_THRESHOLD = 3;

const _errorTracker = {
  _ts: [],
  record() {
    const now = Date.now();
    this._ts = [...this._ts.filter(ts => now - ts < 60_000), now];
    if (this._ts.length >= 2) {
      logger.warn(`Warning: ${this._ts.length} errors/min - check Gemini quota`);
    }
  },
};

const TOOL_THINKING = {
  getAvailableUnits: args => `Checking available ${args.type || 'emergency'} units${args.zone ? ` in ${args.zone}` : ''}...`,
  getRoute: args => `Calculating fastest route: ${args.origin} -> ${args.destination}...`,
  blockRoad: args => `Closing road edge ${args.edgeId} - ${args.reason || 'structural failure'}...`,
  dispatchUnit: args => `Dispatching unit ${args.unitId} to zone ${args.destination}...`,
  returnUnit: args => `Recalling unit ${args.unitId} back to base...`,
  getHospitalCapacity: args => `Checking hospital beds${args.zone ? ` near ${args.zone}` : ''}...`,
  updateHospitalCapacity: args => `Updating hospital ${args.hospitalId} intake...`,
  getWeather: args => `Reading wind and fire spread data for zone ${args.zone}...`,
  notifyCitizens: args => `Broadcasting public alert to zone ${args.zone}...`,
};

const COORDINATOR_SYSTEM_PROMPT = `You are AEGIS, the AI emergency coordinator for Delhi.

Always call getAvailableUnits() first.
Then call getRoute() before any dispatch.
Then call dispatchUnit() for chosen units.
For fires, call getWeather().
For casualties, call getHospitalCapacity() before routing patients.

Only produce concise public-safe status lines. Do not reveal hidden chain-of-thought or internal policy text.
Prefer short factual reasoning that can be shown in a live operations UI.

Delhi zones: CP=Connaught Place, RP=Rajpath, KB=Karol Bagh, LN=Lajpat Nagar,
DW=Dwarka, RH=Rohini, SD=Shahdara, NP=Nehru Place, IGI=Airport, OKH=Okhla.
Yamuna Bridge is edge e5 (CP<->SD).

Decision priority: life safety > property > infrastructure.
Match unit specialty to incident type. Dispatch the minimum viable response first.
Every decision is logged for audit.`;

const FAST_PATH_UNIT_MAP = {
  vehicle_accident: 'police',
  structural_fire: 'fire',
  medical_emergency: 'ems',
  mass_casualty: 'ems',
  power_outage: 'traffic',
  hazmat: 'fire',
  building_collapse: 'ems',
};

export async function startCoordinatorLoop() {
  logger.success('Coordinator loop started');

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

export async function processEvent(event) {
  const incidentId = event.id;

  if (_processingIds.has(incidentId)) {
    logger.warn(`Duplicate processing attempt for ${incidentId} - skipped`);
    return;
  }
  _processingIds.add(incidentId);

  try {
    const fw = await runFirewall(event);
    if (!fw?.passed) {
      logger.firewall('BLOCK', `Event ${incidentId} quarantined`);
      return;
    }

    const incident = worldState.createIncident({
      id: incidentId,
      type: event.type,
      subtype: event.subtype,
      zone: event.zone,
      priority: event.priority,
      description: event.description,
      metadata: event,
    });

    Incident.create({
      incidentId,
      type: event.type,
      subtype: event.subtype,
      zone: event.zone,
      priority: event.priority,
      description: event.description,
      metadata: event,
    }).catch(() => {});

    safeBroadcast({ type: 'INCIDENT_RECEIVED', payload: { ...incident } });

    if (event.priority <= 3 && event._source === 'simulation_fallback') {
      await fastPathDispatch(event, incidentId);
      return;
    }

    if (isInDegradedMode()) {
      logger.warn(`Degraded mode - fast-path for ${incidentId}`);
      await fastPathDispatch(event, incidentId, { degradedMode: true });
      return;
    }

    safeBroadcast({
      type: 'THOUGHT_START',
      payload: { agentId: 'coordinator', incidentId, eventType: event.type, zone: event.zone },
    });

    const sourceLabel = event._source === 'live_news'
      ? '[LIVE NEWS]'
      : event._source === 'simulation_fallback'
        ? '[SIMULATION]'
        : event._scenario
          ? '[DEMO]'
          : '[INCIDENT]';

    const openingText =
      `${sourceLabel} ${event.type.replace(/_/g, ' ').toUpperCase()} in ${event.zone} - Priority ${event.priority}/10\n` +
      `${event._headline ? `Source: "${event._headline}"\n` : ''}` +
      'Analyzing city state and available resources...\n\n';

    safeBroadcastToken('coordinator', incidentId, openingText, false);
    await demoPause(DEMO_PACING.afterThoughtStartMs);

    const geminiTools = convertToGeminiTools(ALL_TOOLS_SCHEMAS);
    const snapshot = worldState.getSnapshot();
    const userMessage = buildUserMessage(event, snapshot);
    let fullReasoning = openingText;
    const toolCallLog = [];

    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction: COORDINATOR_SYSTEM_PROMPT,
      safetySettings: GEMINI_SAFETY_SETTINGS,
      generationConfig: {
        temperature: MODEL_LIMITS.coordinatorTemperature,
        maxOutputTokens: MODEL_LIMITS.coordinatorMaxOutputTokens,
      },
      tools: [{ functionDeclarations: geminiTools }],
    });

    const chat = model.startChat({ history: [] });
    let iterations = 0;
    let currentMsg = userMessage;

    while (iterations < MAX_REACT_ITERATIONS) {
      iterations++;

      let functionCalls = [];

      try {
        const streamResult = await runGeminiStream(chat, currentMsg);

        for await (const chunk of streamResult.stream) {
          const text = safelyReadChunkText(chunk);
          if (text) {
            safeBroadcastToken('coordinator', incidentId, text, false);
            fullReasoning += text;
          }
        }

        const finalResponse = await streamResult.response;
        const finalCalls = finalResponse.functionCalls?.() || [];
        if (finalCalls.length > 0) {
          functionCalls = finalCalls;
        }

        _consecutiveFailures.count = 0;
      } catch (streamErr) {
        logger.error('Gemini stream error:', streamErr.message);
        _errorTracker.record(streamErr.message);
        _consecutiveFailures.count += 1;
        _consecutiveFailures.lastFailAt = Date.now();

        if (isRateLimitError(streamErr)) {
          safeBroadcastToken('coordinator', incidentId, '\nRate limit reached - retrying in 60 seconds\n', false);
          await sleep(60_000);
          eventQueue.enqueue(event);
          safeBroadcast({
            type: 'THOUGHT_END',
            payload: { agentId: 'coordinator', incidentId, decision: 'Rate limited - re-queued' },
          });
          return;
        }

        if (isInvalidArgumentError(streamErr)) {
          logger.error(`Gemini invalid argument for ${incidentId}: ${serializeForLog(currentMsg)}`);
        }

        break;
      }

      if (!functionCalls.length) {
        logger.agent('coordinator', `Done after ${iterations} step(s)`);
        break;
      }

      const functionResponses = [];

      for (const call of functionCalls) {
        const toolName = call.name;
        const toolArgs = call.args || {};
        const thinkingMsg = TOOL_THINKING[toolName]?.(toolArgs) || `Running ${toolName}...`;

        safeBroadcastToken('coordinator', incidentId, `\n${thinkingMsg}`, false);
        fullReasoning += `\n${thinkingMsg}`;

        const execResult = await executeTool(toolName, JSON.stringify(toolArgs));
        const toolResult = execResult.result;
        const toolEntry = {
          name: toolName,
          arguments: toolArgs,
          result: toolResult,
          step: iterations,
        };
        toolCallLog.push(toolEntry);

        const summary = buildResultSummary(toolName, toolResult, toolArgs);
        safeBroadcastToken('coordinator', incidentId, `\n${summary}`, false);
        fullReasoning += `\n${summary}`;

        const toolPayload = {
          agentId: 'coordinator',
          incidentId,
          tool: toolName,
          args: toolArgs,
          result: toolResult,
        };
        safeBroadcast({ type: 'TOOL_CALL', payload: toolPayload });
        safeBroadcast({ type: 'TOOL_EXECUTED', payload: toolPayload });

        if (toolName === 'dispatchUnit' && toolResult?.success) {
          await broadcastRouteArtifacts(toolCallLog, toolResult, incidentId);
        }

        functionResponses.push({
          functionResponse: {
            name: toolName,
            response: trimForContext(toolName, toolResult),
          },
        });

        await demoPause(DEMO_PACING.betweenToolsMs);
      }

      currentMsg = functionResponses;
    }

    const decisionData = buildDecisionArtifact(event, toolCallLog);
    await finalizeIncident({
      event,
      incidentId,
      fullReasoning,
      toolCallLog,
      decisionData,
      iterations,
    });
  } catch (err) {
    logger.error('processEvent fatal error:', err.message);
    _errorTracker.record(err.message);
    safeBroadcast({
      type: 'THOUGHT_END',
      payload: { agentId: 'coordinator', incidentId, decision: `Error: ${err.message}` },
    });
  } finally {
    _processingIds.delete(incidentId);
  }
}

async function fastPathDispatch(event, incidentId, options = {}) {
  safeBroadcast({
    type: 'THOUGHT_START',
    payload: { agentId: 'coordinator', incidentId, eventType: event.type, zone: event.zone },
  });
  await demoPause(DEMO_PACING.afterThoughtStartMs);

  const unitType = FAST_PATH_UNIT_MAP[event.type] || 'police';
  const allUnits = worldState.getAvailableUnits(unitType);
  const unit = allUnits.find(candidate => candidate.currentZone === event.zone) || allUnits[0];
  const toolCallLog = [];
  let reasoning = '';

  if (!unit) {
    reasoning = options.degradedMode
      ? `[RULE-BASED] Gemini unavailable and no ${unitType} units are free for ${event.type} in ${event.zone}.`
      : `[RULE-BASED] No ${unitType} units available for ${event.type} in ${event.zone}. Monitoring.`;
    safeBroadcastToken('coordinator', incidentId, reasoning, false);
  } else {
    const routeResult = await executeTool('getRoute', JSON.stringify({
      origin: unit.currentZone,
      destination: event.zone,
    }));
    const dispatchResult = await executeTool('dispatchUnit', JSON.stringify({
      unitId: unit.id,
      destination: event.zone,
      incidentId,
    }));

    toolCallLog.push({
      name: routeResult.name,
      arguments: routeResult.parsedArgs,
      result: routeResult.result,
      step: 1,
    });
    toolCallLog.push({
      name: dispatchResult.name,
      arguments: dispatchResult.parsedArgs,
      result: dispatchResult.result,
      step: 1,
    });

    safeBroadcast({
      type: 'TOOL_CALL',
      payload: { agentId: 'coordinator', incidentId, tool: routeResult.name, args: routeResult.parsedArgs, result: routeResult.result },
    });
    safeBroadcast({
      type: 'TOOL_EXECUTED',
      payload: { agentId: 'coordinator', incidentId, tool: routeResult.name, args: routeResult.parsedArgs, result: routeResult.result },
    });
    await demoPause(DEMO_PACING.betweenToolsMs);
    safeBroadcast({
      type: 'TOOL_CALL',
      payload: { agentId: 'coordinator', incidentId, tool: dispatchResult.name, args: dispatchResult.parsedArgs, result: dispatchResult.result },
    });
    safeBroadcast({
      type: 'TOOL_EXECUTED',
      payload: { agentId: 'coordinator', incidentId, tool: dispatchResult.name, args: dispatchResult.parsedArgs, result: dispatchResult.result },
    });

    if (dispatchResult.result?.success) {
      await broadcastRouteArtifacts(toolCallLog, dispatchResult.result, incidentId);
    }
    await demoPause(DEMO_PACING.betweenToolsMs);

    reasoning = `[RULE-BASED] ${unit.name} dispatched to ${event.zone}. ETA: ${routeResult.result?.totalTimeMinutes || '?'} min.`;
    safeBroadcastToken('coordinator', incidentId, reasoning, false);
  }

  const decisionData = buildDecisionArtifact(event, toolCallLog, {
    forcedSummary: reasoning,
    forceFinalAction: toolCallLog.some(call => call.name === 'dispatchUnit' && call.result?.success) ? 'dispatchUnit' : 'monitor',
  });

  await finalizeIncident({
    event,
    incidentId,
    fullReasoning: reasoning,
    toolCallLog,
    decisionData,
    iterations: toolCallLog.length ? 1 : 0,
  });
}

async function finalizeIncident({ event, incidentId, fullReasoning, toolCallLog, decisionData, iterations }) {
  const persistResult = await AuditEntry.safeCreate({
    incidentId,
    agentType: 'coordinator',
    eventType: event.type,
    zone: event.zone,
    priority: event.priority,
    reasoning: fullReasoning,
    toolCalls: toolCallLog,
    decision: decisionData.plan_summary,
    metadata: {
      decisionData,
      iterations,
      persisted: true,
      dispatched: toolCallLog
        .filter(call => call.name === 'dispatchUnit' && call.result?.success)
        .map(call => call.result.unit.id),
    },
  });

  const decisionPayload = {
    finalAction: decisionData.final_action,
    actionArgs: decisionData.action_args,
    planSummary: decisionData.plan_summary,
    stepwiseRationale: decisionData.stepwise_rationale,
    actionableSummary: decisionData.actionable_summary,
    toolCallsDetailed: decisionData.tool_calls,
    persisted: persistResult.persisted,
  };

  await demoPause(DEMO_PACING.beforeDecisionMs);
  safeBroadcastToken('coordinator', incidentId, `\n\n[DECISION]\n${decisionData.plan_summary}`, false);
  safeBroadcastDecision(
    'coordinator',
    incidentId,
    fullReasoning,
    toolCallLog,
    decisionData.plan_summary,
    event.type,
    event.zone,
    decisionPayload,
  );
  await demoPause(DEMO_PACING.beforeThoughtEndMs);
  safeBroadcast({
    type: 'THOUGHT_END',
    payload: { agentId: 'coordinator', incidentId, decision: decisionData.plan_summary },
  });

  const dispatched = toolCallLog
    .filter(call => call.name === 'dispatchUnit' && call.result?.success)
    .map(call => call.result.unit.id);

  if (dispatched.length > 0) {
    worldState.updateIncident(incidentId, { unitsDispatched: dispatched });
  }

  logger.agent(
    'coordinator',
    `Done in ${iterations} step(s). Dispatched: ${dispatched.length} unit(s). Tools used: ${toolCallLog.length}`,
  );
}

async function broadcastRouteArtifacts(toolCallLog, dispatchResult, incidentId) {
  const routeCall = [...toolCallLog].reverse().find(call =>
    call.name === 'getRoute' &&
    call.result?.success &&
    Array.isArray(call.result?.path) &&
    call.result.path.length > 0,
  );

  if (!routeCall) {
    return;
  }

  const routePayload = {
    unitId: dispatchResult.unit.id,
    unitType: dispatchResult.unit.type,
    unitName: dispatchResult.unit.name,
    eventId: incidentId,
    incidentId,
    origin: routeCall.result.origin,
    destination: routeCall.result.destination,
    zonePath: routeCall.result.zonePath || [],
    path: routeCall.result.path,
    distanceMeters: routeCall.result.distanceMeters || 0,
    etaSeconds: routeCall.result.etaSeconds || (routeCall.result.totalTimeMinutes || 0) * 60,
    etaMinutes: routeCall.result.totalTimeMinutes || Math.round((routeCall.result.etaSeconds || 0) / 60),
    timestamp: new Date().toISOString(),
  };

  logger.info(
    `[ROUTE_COMPUTED] unitId=${routePayload.unitId} distance=${routePayload.distanceMeters} eta=${routePayload.etaSeconds} pathLen=${routePayload.path.length}`,
  );

  worldState.setUnitRoute(dispatchResult.unit.id, routePayload);

  safeBroadcast({ type: 'ROUTE_COMPUTED', payload: routePayload });
  safeBroadcast({ type: 'UNIT_ROUTE', payload: routePayload });
}

async function runGeminiStream(chat, input, attempt = 0) {
  try {
    return await chat.sendMessageStream(input);
  } catch (err) {
    if (isServiceUnavailableError(err) && attempt === 0) {
      logger.warn('Gemini service unavailable - retrying once in 5 seconds');
      await sleep(5000);
      return runGeminiStream(chat, input, 1);
    }
    throw err;
  }
}

function safelyReadChunkText(chunk) {
  try {
    return typeof chunk.text === 'function' ? chunk.text() : '';
  } catch {
    return '';
  }
}

function convertToGeminiTools(openaiSchemas) {
  return openaiSchemas.map(schema => {
    const fn = schema.function;
    return {
      name: fn.name,
      description: (fn.description || '').slice(0, 200),
      parameters: {
        type: 'OBJECT',
        properties: convertProps(fn.parameters?.properties || {}),
        required: fn.parameters?.required || [],
      },
    };
  });
}

function convertProps(props) {
  const out = {};

  for (const [key, value] of Object.entries(props)) {
    const geminiType = (value.type || 'string').toUpperCase();
    out[key] = {
      type: geminiType === 'INTEGER' ? 'NUMBER' : geminiType,
      description: (value.description || '').slice(0, 200),
    };

    if (value.enum && geminiType === 'STRING') {
      out[key].enum = value.enum;
    }

    if (value.type === 'object' && value.properties) {
      out[key].type = 'OBJECT';
      out[key].properties = convertProps(value.properties);
    }

    if (value.type === 'array' && value.items) {
      const itemType = (value.items.type || 'string').toUpperCase();
      out[key].type = 'ARRAY';
      out[key].items = {
        type: itemType === 'INTEGER' ? 'NUMBER' : itemType,
        ...(value.items.description ? { description: value.items.description.slice(0, 200) } : {}),
      };
    }
  }

  return out;
}

function trimForContext(toolName, result) {
  if (!result || result.success === false) {
    return result;
  }

  switch (toolName) {
    case 'getAvailableUnits':
      return {
        success: true,
        totalAvailable: result.totalAvailable,
        summary: result.summary,
        units: (result.units || []).map(unit => ({
          id: unit.id,
          name: unit.name,
          type: unit.type,
          currentZone: unit.currentZone,
        })),
        note: result.note,
      };
    case 'getHospitalCapacity':
      return {
        success: true,
        recommendation: result.recommendation,
        totalAvailableBeds: result.totalAvailableBeds,
        totalAvailableIcu: result.totalAvailableIcu,
        hospitals: (result.hospitals || []).slice(0, 3).map(hospital => ({
          id: hospital.id,
          name: hospital.name,
          zone: hospital.zone,
          availableBeds: hospital.availableBeds,
          availableIcu: hospital.availableIcu,
          status: hospital.status,
        })),
      };
    case 'getRoute':
      return {
        success: result.success,
        zonePath: result.zonePath,
        path: result.path,
        distanceMeters: result.distanceMeters,
        etaSeconds: result.etaSeconds,
        totalTimeMinutes: result.totalTimeMinutes,
        geometry_type: result.geometry_type,
        error: result.error,
        suggestion: result.suggestion,
      };
    default:
      return result;
  }
}

function buildResultSummary(toolName, result, args) {
  if (result?.success === false) {
    return `  Failed: ${result.error || 'unknown error'}`;
  }

  switch (toolName) {
    case 'getAvailableUnits':
      return `  ${result.totalAvailable} units available (P:${result.summary?.police} F:${result.summary?.fire} E:${result.summary?.ems} T:${result.summary?.traffic})`;
    case 'getRoute':
      return result.success
        ? `  Route: ${(result.pathNames || result.zonePath || []).join(' -> ')} - ETA ${result.totalTimeMinutes} min`
        : `  No route: ${result.error}`;
    case 'blockRoad':
      return `  ${result.edgeName || args.edgeId} CLOSED - all routing rerouted`;
    case 'dispatchUnit':
      return `  ${result.unit?.callSign || args.unitId} -> ${args.destination}`;
    case 'returnUnit':
      return `  ${result.unit?.name || args.unitId} returned to base`;
    case 'getHospitalCapacity':
      return `  ${result.recommendation || `${result.totalAvailableBeds} beds available`}`;
    case 'getWeather':
      return `  Wind: ${result.weather?.windSpeed}km/h ${result.weather?.windDirection} - Fire spread: ${result.weather?.fireSpreadRisk}`;
    case 'notifyCitizens':
      return `  Alert sent to zone ${args.zone} [${(args.severity || 'high').toUpperCase()}]`;
    default:
      return `  ${toolName} completed`;
  }
}

function buildDecisionArtifact(event, toolCallLog, options = {}) {
  const dispatchCalls = toolCallLog.filter(call => call.name === 'dispatchUnit' && call.result?.success);
  const routeCalls = toolCallLog.filter(call => call.name === 'getRoute' && call.result?.success);
  const hospitalCalls = toolCallLog.filter(call => call.name === 'getHospitalCapacity' && call.result?.success);
  const weatherCalls = toolCallLog.filter(call => call.name === 'getWeather' && call.result?.success);
  const roadBlocks = toolCallLog.filter(call => call.name === 'blockRoad' && call.result?.success);
  const notificationCalls = toolCallLog.filter(call => call.name === 'notifyCitizens' && call.result?.success);

  const finalAction = options.forceFinalAction
    || (dispatchCalls[0] ? 'dispatchUnit' : roadBlocks[0] ? 'blockRoad' : notificationCalls[0] ? 'notifyCitizens' : 'monitor');

  const actionArgs = dispatchCalls[0]?.arguments
    || roadBlocks[0]?.arguments
    || notificationCalls[0]?.arguments
    || {};

  const stepwiseRationale = [
    `Incident ${event.type.replace(/_/g, ' ')} in ${event.zone} with priority ${event.priority}/10 was assessed against live city state.`,
  ];

  const unitCheck = toolCallLog.find(call => call.name === 'getAvailableUnits' && call.result?.success);
  if (unitCheck) {
    stepwiseRationale.push(`Available units found: ${unitCheck.result.totalAvailable}.`);
  }
  if (routeCalls[0]) {
    stepwiseRationale.push(`Primary route ETA is ${routeCalls[0].result.totalTimeMinutes} minutes over ${routeCalls[0].result.distanceMeters || 0} meters.`);
  }
  if (hospitalCalls[0]) {
    stepwiseRationale.push(`Hospital capacity check recommended ${hospitalCalls[0].result.recommendation || 'the nearest available facility'}.`);
  }
  if (weatherCalls[0]) {
    stepwiseRationale.push(`Weather context recorded fire spread risk as ${weatherCalls[0].result.weather?.fireSpreadRisk || 'unknown'}.`);
  }
  if (roadBlocks[0]) {
    stepwiseRationale.push(`Road closure applied on ${roadBlocks[0].result.edgeName || roadBlocks[0].arguments.edgeId}.`);
  }
  if (dispatchCalls[0]) {
    stepwiseRationale.push(`Dispatched ${dispatchCalls.length} unit(s): ${dispatchCalls.map(call => call.result.unit?.name || call.arguments.unitId).join(', ')}.`);
  } else if (!options.forcedSummary) {
    stepwiseRationale.push('No unit was dispatched after evaluating tool results.');
  }
  if (notificationCalls[0]) {
    stepwiseRationale.push(`Citizen alert sent to ${notificationCalls.map(call => call.arguments.zone).join(', ')}.`);
  }

  const planSummary = options.forcedSummary || (
    dispatchCalls[0]
      ? `Dispatch ${dispatchCalls.length} unit(s) to ${event.zone} with the computed safe route.`
      : roadBlocks[0]
        ? `Block the affected road segment and monitor rerouted operations for ${event.zone}.`
        : notificationCalls[0]
          ? `Issue a public alert for ${event.zone} and continue monitoring.`
          : `Assess ${event.type.replace(/_/g, ' ')} in ${event.zone} and keep monitoring for changes.`
  );

  return {
    final_action: finalAction,
    action_args: actionArgs,
    plan_summary: planSummary,
    actionable_summary: planSummary,
    stepwise_rationale: stepwiseRationale.slice(0, 6),
    tool_calls: toolCallLog.map(call => ({
      tool: call.name,
      args: call.arguments,
      resultSummary: summarizeToolResult(call),
      success: call.result?.success !== false,
    })),
  };
}

function summarizeToolResult(call) {
  if (call.result?.success === false) {
    return call.result.error || 'Tool failed';
  }

  switch (call.name) {
    case 'getRoute':
      return `ETA ${call.result.totalTimeMinutes} min, distance ${call.result.distanceMeters || 0} m`;
    case 'dispatchUnit':
      return `${call.result.unit?.name || call.arguments.unitId} dispatched to ${call.arguments.destination}`;
    case 'getAvailableUnits':
      return `${call.result.totalAvailable} unit(s) available`;
    case 'getHospitalCapacity':
      return call.result.recommendation || 'Hospital availability checked';
    case 'getWeather':
      return `Fire spread risk ${call.result.weather?.fireSpreadRisk || 'unknown'}`;
    case 'blockRoad':
      return `${call.result.edgeName || call.arguments.edgeId} blocked`;
    case 'notifyCitizens':
      return `Alert sent to ${call.arguments.zone}`;
    default:
      return 'Tool completed';
  }
}

function buildUserMessage(event, snapshot) {
  const stats = snapshot.stats;
  const availableUnits = snapshot.units.filter(unit => unit.status === 'available');
  const activeIncidents = snapshot.activeIncidents.filter(incident => incident.id !== event.id);
  const quarantinedEvents = snapshot.quarantineQueue?.length || 0;

  return `EMERGENCY REQUIRING IMMEDIATE RESPONSE:

Type: ${event.type}${event.subtype ? `/${event.subtype}` : ''}
Zone: ${event.zone}
Priority: ${event.priority}/10
Description: ${(event.description || '').slice(0, 180)}
ID: ${event.id}

CITY STATE:
Available units: ${stats.availableUnits}/${stats.totalUnits}
  Police: ${availableUnits.filter(unit => unit.type === 'police').length}
  Fire:   ${availableUnits.filter(unit => unit.type === 'fire').length}
  EMS:    ${availableUnits.filter(unit => unit.type === 'ems').length}
  Traffic:${availableUnits.filter(unit => unit.type === 'traffic').length}
Blocked roads: ${stats.blockedRoads > 0 ? snapshot.blockedEdges.join(', ') : 'none'}
Other active incidents: ${activeIncidents.length > 0 ? activeIncidents.map(incident => `${incident.type} in ${incident.zone}`).join('; ') : 'none'}
Security backlog: ${quarantinedEvents} quarantined event(s)

Coordinate a safe response and keep output concise for a public decision log.`;
}

function isInDegradedMode() {
  if (_consecutiveFailures.count >= DEGRADED_THRESHOLD) {
    if (Date.now() - _consecutiveFailures.lastFailAt > 300_000) {
      _consecutiveFailures.count = 0;
      logger.success('Gemini recovered - exiting degraded mode');
      return false;
    }
    return true;
  }
  return false;
}

function isRateLimitError(err) {
  return err?.status === 429 || /429|resource_exhausted|rate limit/i.test(err?.message || '');
}

function isServiceUnavailableError(err) {
  return err?.status === 503 || /503|service unavailable|unavailable/i.test(err?.message || '');
}

function isInvalidArgumentError(err) {
  return err?.status === 400 || /400|invalid argument/i.test(err?.message || '');
}

function serializeForLog(value) {
  try {
    return typeof value === 'string' ? value.slice(0, 600) : JSON.stringify(value).slice(0, 600);
  } catch {
    return '[unserializable input]';
  }
}

function safeBroadcast(payload) {
  try {
    broadcast(payload);
  } catch (err) {
    logger.warn('Broadcast failed:', err.message);
  }
}

function safeBroadcastToken(agentId, incidentId, token, done = false) {
  try {
    broadcastToken(agentId, incidentId, token, done);
  } catch (err) {
    logger.warn('Token broadcast failed:', err.message);
  }
}

function safeBroadcastDecision(agentId, incidentId, reasoning, toolCalls, decision, eventType, zone, extra = {}) {
  try {
    broadcastDecision(agentId, incidentId, reasoning, toolCalls, decision, eventType, zone, extra);
  } catch (err) {
    logger.warn('Decision broadcast failed:', err.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function demoPause(ms) {
  if (!DEMO_PACING.enabled || !Number.isFinite(ms) || ms <= 0) {
    return;
  }

  await sleep(ms);
}
