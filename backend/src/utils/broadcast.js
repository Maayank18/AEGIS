/*
 * Why changed: add guarded broadcast logging and prevent silent websocket override behavior.
 * Security rationale: firewall and routing events now log ingress/egress so quarantines and route messages can be traced without depending on the UI.
 */
import { logger } from './logger.js';

let _broadcastFn = null;
let _pendingMessages = [];

const LOGGED_TYPES = new Set([
  'FIREWALL_BLOCK',
  'FIREWALL_PASS',
  'ROUTE_COMPUTED',
  'UNIT_UPDATE',
  'UNIT_ROUTE',
]);

export function setBroadcast(fn) {
  if (_broadcastFn && _broadcastFn !== fn) {
    logger.warn('Broadcast function already set - overriding existing WebSocket binding');
  }

  _broadcastFn = fn;

  if (_pendingMessages.length > 0) {
    const pending = [..._pendingMessages];
    _pendingMessages = [];
    pending.forEach(message => {
      try {
        fn(message);
      } catch (err) {
        logger.warn('Buffered broadcast failed during flush:', err.message);
      }
    });
  }
}

export function broadcast(data) {
  const message = {
    ...data,
    _ts: Date.now(),
  };

  if (LOGGED_TYPES.has(message.type)) {
    const payloadId = message.payload?.eventId || message.payload?.unitId || message.payload?.incidentId || 'n/a';
    logger.info(`[BROADCAST] type=${message.type} payloadId=${payloadId}`);
  }

  if (_broadcastFn) {
    try {
      _broadcastFn(message);
    } catch (err) {
      logger.warn(`Broadcast send failed for ${message.type}:`, err.message);
    }
    return;
  }

  if (_pendingMessages.length < 50) {
    _pendingMessages.push(message);
  }
}

export function broadcastToken(agentId, incidentId, token, done = false) {
  broadcast({
    type: 'THOUGHT_TOKEN',
    payload: { agentId, incidentId, token, done },
  });
}

export function broadcastDecision(agentId, incidentId, reasoning, toolCalls, decision, eventType, zone, extra = {}) {
  broadcast({
    type: 'AGENT_DECISION',
    payload: {
      agentId,
      incidentId,
      reasoning,
      toolCalls,
      decision,
      eventType,
      zone,
      timestamp: new Date().toISOString(),
      ...extra,
    },
  });
}

export function broadcastReplan(reason, affectedIncidents) {
  broadcast({
    type: 'REPLAN_TRIGGERED',
    payload: { reason, affectedIncidents, timestamp: new Date().toISOString() },
  });
}
