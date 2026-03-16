import { create } from 'zustand';

export const ZONE_META = {
  CP:  { name: 'Connaught Place', lat: 28.6315, lng: 77.2167 },
  RP:  { name: 'Rajpath / India Gate', lat: 28.6129, lng: 77.2295 },
  KB:  { name: 'Karol Bagh',     lat: 28.6518, lng: 77.1909 },
  LN:  { name: 'Lajpat Nagar',   lat: 28.5677, lng: 77.2433 },
  DW:  { name: 'Dwarka',         lat: 28.5921, lng: 77.0460 },
  RH:  { name: 'Rohini',         lat: 28.7459, lng: 77.1126 },
  SD:  { name: 'Shahdara',       lat: 28.6716, lng: 77.2916 },
  NP:  { name: 'Nehru Place',    lat: 28.5491, lng: 77.2511 },
  IGI: { name: 'IGI Airport',    lat: 28.5562, lng: 77.0999 },
  OKH: { name: 'Okhla',         lat: 28.5355, lng: 77.2756 },
};

// Strip replan- prefix to get stable incident ID
function baseId(id) {
  return (id || '').replace(/^replan-/, '');
}

export const useWorldStore = create((set, get) => ({
  connected:      false,
  units:          [],
  incidents:      [],
  hospitals:      [],
  blockedEdges:   [],
  stats:          {},

  // Only ONE active thought shown at a time. Max 5 completed in history.
  activeThought:  null,   // The thought currently streaming (object)
  thoughtHistory: [],     // Completed thoughts — summary only, max 5

  eventFeed:      [],     // Deduped by id, max 15
  securityFeed:   [],     // Only BLOCK/ROAD events, max 10
  auditTimeline:  [],     // One entry per base incident, max 15

  replanBanner:   null,
  activeScenario: null,

  setConnected: v => set({ connected: v }),

  loadInitialState: snapshot => set({
    units:        snapshot.units           || [],
    incidents:    snapshot.activeIncidents || [],
    hospitals:    snapshot.hospitals       || [],
    blockedEdges: snapshot.blockedEdges    || [],
    stats:        snapshot.stats          || {},
  }),

  updateStats: stats => set({ stats }),

  upsertUnit: unit => set(state => ({
    units: state.units.some(u => u.id === unit.id)
      ? state.units.map(u => u.id === unit.id ? { ...u, ...unit } : u)
      : [...state.units, unit],
  })),

  addIncident: incident => set(state => {
    if (state.eventFeed.some(e => e.id === incident.id)) return {};
    return {
      incidents: [incident, ...state.incidents.filter(i => i.id !== incident.id)].slice(0, 30),
      eventFeed: [
        {
          id:          incident.id,
          type:        incident.type,
          zone:        incident.zone,
          priority:    incident.priority,
          description: incident.description,
          source:      incident.metadata?._source || incident._source,
          headline:    incident.metadata?._headline,
          timestamp:   incident.createdAt || new Date().toISOString(),
        },
        ...state.eventFeed,
      ].slice(0, 15),
    };
  }),

  updateIncident: (id, updates) => set(state => ({
    incidents: state.incidents.map(i => i.id === id ? { ...i, ...updates } : i),
  })),

  // ── Thought: ONE active card at a time ────────────────────────────────────
  startThought: ({ agentId, incidentId }) => {
    const base = baseId(incidentId);
    set(state => {
      // If there's an active thought for the same base incident, just reset it
      if (state.activeThought && baseId(state.activeThought.incidentId) === base) {
        return {
          activeThought: {
            ...state.activeThought,
            incidentId,
            tokens: '',
            toolCalls: [],
            done: false,
            replanCount: (state.activeThought.replanCount || 0) + 1,
          },
        };
      }
      // Archive current active thought to history
      const newHistory = state.activeThought
        ? [state.activeThought, ...state.thoughtHistory].slice(0, 5)
        : state.thoughtHistory;

      return {
        activeThought: {
          id: `${agentId}-${base}`,
          agentId, incidentId, baseId: base,
          tokens: '', toolCalls: [], done: false,
          replanCount: 0,
          startedAt: new Date().toISOString(),
        },
        thoughtHistory: newHistory,
      };
    });
  },

  appendToken: ({ agentId, incidentId, token, done }) => {
    const base = baseId(incidentId);
    set(state => {
      if (!state.activeThought) return {};
      if (baseId(state.activeThought.incidentId) !== base) return {};

      const updated = { ...state.activeThought, tokens: state.activeThought.tokens + token, done };
      if (done) {
        return {
          activeThought: null,
          thoughtHistory: [updated, ...state.thoughtHistory].slice(0, 5),
        };
      }
      return { activeThought: updated };
    });
  },

  addToolCall: ({ agentId, incidentId, tool, args, result }) => {
    const base = baseId(incidentId);
    set(state => {
      if (!state.activeThought || baseId(state.activeThought.incidentId) !== base) return {};
      return {
        activeThought: {
          ...state.activeThought,
          toolCalls: [...state.activeThought.toolCalls, { tool, args, result, ts: Date.now() }],
        },
      };
    });
  },

  // ── Security ───────────────────────────────────────────────────────────────
  addSecurityEvent: ev => set(state => {
    if (ev.eventType === 'FIREWALL_PASS') return {};
    if (state.securityFeed.some(e => e.eventId === ev.eventId && ev.eventId)) return {};
    return { securityFeed: [{ ...ev, _key: Date.now() }, ...state.securityFeed].slice(0, 10) };
  }),

  // ── Audit — one entry per base incident, always update not duplicate ───────
  addAuditEntry: entry => set(state => {
    const base = baseId(entry.incidentId);
    const idx  = state.auditTimeline.findIndex(e => baseId(e.incidentId) === base);

    const merged = {
      ...entry,
      incidentId: base,
      toolCalls: entry.toolCalls?.length > 0 ? entry.toolCalls
               : (idx !== -1 ? state.auditTimeline[idx].toolCalls : []),
    };

    if (idx !== -1) {
      const list = [...state.auditTimeline];
      list[idx] = { ...list[idx], ...merged };
      return { auditTimeline: list };
    }
    return { auditTimeline: [merged, ...state.auditTimeline].slice(0, 15) };
  }),

  blockEdge:   eid => set(s => ({ blockedEdges: [...new Set([...s.blockedEdges, eid])] })),
  unblockEdge: eid => set(s => ({ blockedEdges: s.blockedEdges.filter(e => e !== eid) })),

  updateHospital: h => set(s => ({
    hospitals: s.hospitals.map(x => x.id === h.id ? { ...x, ...h } : x),
  })),

  showReplanBanner: data => {
    set({ replanBanner: data });
    setTimeout(() => set({ replanBanner: null }), 4000);
  },

  setActiveScenario: s => {
    set({ activeScenario: s });
    setTimeout(() => set({ activeScenario: null }), 4000);
  },

  resetState: () => set({
    units:          get().units.map(u => ({ ...u, status: 'available', destination: null, incidentId: null })),
    incidents:      [],
    blockedEdges:   [],
    activeThought:  null,
    thoughtHistory: [],
    eventFeed:      [],
    securityFeed:   [],
    auditTimeline:  [],
    replanBanner:   null,
    activeScenario: null,
  }),
}));