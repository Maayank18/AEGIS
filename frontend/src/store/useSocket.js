import { useEffect, useRef } from 'react';
import { useWorldStore } from './useWorldStore.js';

const WS_URL = 'ws://localhost:8001';

export function useSocket() {
  const wsRef        = useRef(null);
  const reconnectRef = useRef(null);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  function connect() {
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        useWorldStore.getState().setConnected(true);
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        useWorldStore.getState().setConnected(false);
        reconnectRef.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => {};

      ws.onmessage = evt => {
        try {
          route(JSON.parse(evt.data), useWorldStore.getState());
        } catch {}
      };
    } catch { reconnectRef.current = setTimeout(connect, 3000); }
  }
}

function route(msg, s) {
  const { type, payload } = msg;
  switch (type) {
    case 'INITIAL_STATE':      s.loadInitialState(payload); break;
    case 'SYSTEM_RESET':       s.resetState(); break;

    case 'UNIT_DISPATCHED':
    case 'UNIT_ZONE_UPDATED':  s.upsertUnit(payload); break;
    case 'UNIT_RETURNED':
      s.upsertUnit(payload);
      s.clearUnitRoute(payload.id); // remove route line when unit returns
      break;

    case 'UNIT_ROUTE':         s.setUnitRoute(payload); break;

    case 'INCIDENT_RECEIVED':  s.addIncident(payload); break;
    case 'INCIDENT_CREATED':   break; // suppressed — RECEIVED fires same event
    case 'INCIDENT_UPDATED':   s.updateIncident(payload.id, payload); break;

    case 'THOUGHT_START':
    case 'SUBAGENT_START':     s.startThought(payload); break;
    case 'THOUGHT_TOKEN':      s.appendToken(payload); break;
    case 'TOOL_EXECUTED':      s.addToolCall(payload); break;

    case 'THOUGHT_END':
    case 'SUBAGENT_COMPLETE': {
      const activeThought = s.activeThought;
      if (activeThought && activeThought.incidentId === payload.incidentId) {
        s.addAuditEntry({
          id: `thought-end-${Date.now()}`,
          agentId: payload.agentId,
          incidentId: payload.incidentId,
          eventType: activeThought.eventType,
          zone: activeThought.zone,
          reasoning: activeThought.tokens || '',
          toolCalls: activeThought.toolCalls || [],
          decision: payload.decision || '',
          timestamp: new Date().toISOString(),
        });
      }
      s.appendToken({ agentId: payload.agentId, incidentId: payload.incidentId, token: '', done: true });
      break;
    }

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

    case 'STATS_UPDATE':        s.updateStats(payload); break;
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
