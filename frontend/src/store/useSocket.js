import { useEffect, useRef } from 'react';
import { useWorldStore } from './useWorldStore.js';

const WS_URL = 'ws://localhost:8001';

export function useSocket() {
  const wsRef        = useRef(null);
  const reconnectRef = useRef(null);
  const store        = useWorldStore();

  useEffect(() => {
    connect();
    return () => { clearTimeout(reconnectRef.current); wsRef.current?.close(); };
  }, []);

  function connect() {
    try {
      const ws    = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen   = ()    => store.setConnected(true);
      ws.onclose  = ()    => { store.setConnected(false); reconnectRef.current = setTimeout(connect, 2000); };
      ws.onerror  = ()    => {};
      ws.onmessage = evt => { try { route(JSON.parse(evt.data), store); } catch {} };
    } catch { reconnectRef.current = setTimeout(connect, 3000); }
  }
}

function route(msg, s) {
  const { type, payload } = msg;
  switch (type) {
    case 'INITIAL_STATE':      s.loadInitialState(payload); break;
    case 'SYSTEM_RESET':       s.resetState(); break;

    case 'UNIT_DISPATCHED':
    case 'UNIT_RETURNED':
    case 'UNIT_ZONE_UPDATED':  s.upsertUnit(payload); break;

    case 'INCIDENT_RECEIVED':  s.addIncident(payload); break;
    case 'INCIDENT_CREATED':   break; // suppressed — RECEIVED fires same event
    case 'INCIDENT_UPDATED':   s.updateIncident(payload.id, payload); break;

    case 'THOUGHT_START':
    case 'SUBAGENT_START':     s.startThought(payload); break;
    case 'THOUGHT_TOKEN':      s.appendToken(payload); break;
    case 'TOOL_EXECUTED':      s.addToolCall(payload); break;

    case 'THOUGHT_END':
    case 'SUBAGENT_COMPLETE':
      s.appendToken({ agentId: payload.agentId, incidentId: payload.incidentId, token: '', done: true });
      break;

    // AGENT_DECISION is the canonical audit write — THOUGHT_END no longer writes audit
    case 'AGENT_DECISION':
      s.addAuditEntry({ ...payload, id: `audit-${Date.now()}` });
      break;

    case 'FIREWALL_BLOCK':
      s.addSecurityEvent({ ...payload, eventType: 'FIREWALL_BLOCK' });
      break;
    case 'FIREWALL_PASS':      break; // suppressed

    case 'EDGE_BLOCKED':
      s.blockEdge(payload.edgeId);
      s.addSecurityEvent({ ...payload, eventType: 'ROAD_BLOCKED' });
      break;
    case 'EDGE_UNBLOCKED':     s.unblockEdge(payload.edgeId); break;

    case 'REPLAN_TRIGGERED':   s.showReplanBanner(payload); break;

    case 'HOSPITAL_UPDATED':   s.updateHospital(payload); break;
    case 'HOSPITAL_SIMULATION_TICK':
      if (payload.hospitals) payload.hospitals.forEach(h => s.updateHospital(h));
      break;

    case 'SCENARIO_TRIGGERED': s.setActiveScenario(payload); break;
    case 'CITIZEN_NOTIFICATION':
      s.addSecurityEvent({ ...payload, eventType: 'CITIZEN_ALERT' });
      break;
    case 'CONFLICT_RESOLVED':
      s.addAuditEntry({ ...payload, id: `conflict-${Date.now()}`, agentId: 'coordinator' });
      break;
    default: break;
  }
}