// Broadcast helper — modules import this to send WS messages
// without needing a direct reference to the WebSocket server.
// The server sets the function once on startup via setBroadcast().

let _broadcastFn = null;
let _pendingMessages = []; // buffer messages sent before WS is ready

/**
 * Called once by server.js when the WS server is ready.
 * Flushes any buffered messages immediately.
 */
export function setBroadcast(fn) {
  _broadcastFn = fn;

  // Flush pending messages that arrived before WS was ready
  if (_pendingMessages.length > 0) {
    _pendingMessages.forEach(msg => fn(msg));
    _pendingMessages = [];
  }
}

/**
 * Broadcast a structured message to all connected WS clients.
 * Safe to call before WS is ready — messages are buffered.
 *
 * @param {object} data - Must include a `type` string field.
 */
export function broadcast(data) {
  const message = {
    ...data,
    _ts: Date.now(), // attach server timestamp
  };

  if (_broadcastFn) {
    _broadcastFn(message);
  } else {
    // WS not ready yet — buffer up to 50 messages
    if (_pendingMessages.length < 50) {
      _pendingMessages.push(message);
    }
  }
}

/**
 * Broadcast a streaming token chunk to the ThoughtTrace panel.
 * Called on every chunk from Groq's streaming response.
 */
export function broadcastToken(agentId, incidentId, token, done = false) {
  broadcast({
    type: 'THOUGHT_TOKEN',
    payload: { agentId, incidentId, token, done },
  });
}

/**
 * Broadcast a completed agent decision with full chain-of-thought.
 */
export function broadcastDecision(agentId, incidentId, reasoning, toolCalls, decision, eventType, zone) {
  broadcast({
    type: 'AGENT_DECISION',
    payload: { agentId, incidentId, reasoning, toolCalls, decision, eventType, zone, timestamp: new Date().toISOString() },
  });
}

/**
 * Broadcast a replan trigger event — frontend shows a replan banner.
 */
export function broadcastReplan(reason, affectedIncidents) {
  broadcast({
    type: 'REPLAN_TRIGGERED',
    payload: { reason, affectedIncidents, timestamp: new Date().toISOString() },
  });
}