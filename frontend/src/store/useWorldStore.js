/*
 * Why changed: normalize live route payloads and hydrate security memory state from the backend snapshot.
 * Security rationale: route and quarantine visibility no longer depends on legacy payload assumptions or MongoDB-only data.
 */
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

const FALLBACK_DECISION = 'Response coordinated. See tool execution chain above';

function isMeaningfulDecision(decision) {
  const normalized = (decision || '').trim();
  return normalized && normalized !== FALLBACK_DECISION;
}

function securityEventKey(ev) {
  if (ev._key) return ev._key;
  if (ev.eventId) return ev.eventId;
  if (ev.eventType === 'ROAD_BLOCKED' && ev.edgeId) return `${ev.eventType}:${ev.edgeId}`;
  if (ev.eventType === 'CITIZEN_ALERT' && ev.zone && ev.message) {
    return `${ev.eventType}:${ev.zone}:${ev.message}`;
  }
  return null;
}

function normalizeRoutePath(path = []) {
  return (path || [])
    .map(point => {
      if (Array.isArray(point)) {
        const [first, second] = point;
        const looksLikeLngLat = Math.abs(first) > 60 && Math.abs(second) < 60;
        return looksLikeLngLat ? { lat: second, lng: first } : { lat: first, lng: second };
      }
      if (typeof point === 'string' && ZONE_META[point]) {
        const zone = ZONE_META[point];
        return { lat: zone.lat, lng: zone.lng, zone: point, name: zone.name };
      }
      return {
        lat: point?.lat ?? point?.latitude,
        lng: point?.lng ?? point?.longitude,
        ...(point?.zone ? { zone: point.zone } : {}),
        ...(point?.name ? { name: point.name } : {}),
      };
    })
    .filter(point => typeof point.lat === 'number' && typeof point.lng === 'number');
}

export const useWorldStore = create((set, get) => ({
  connected:      false,
  units:          [],
  incidents:      [],
  hospitals:      [],
  blockedEdges:   [],
  stats:          {},
  unitRoutes:     {}, // unitId → { path, unitType, unitName, origin, destination, etaMinutes, incidentId }

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
    securityFeed: (snapshot.quarantineQueue || []).map(entry => ({
      ...entry,
      eventType: entry.eventType || 'FIREWALL_BLOCK',
      _key: securityEventKey(entry) || `${entry.eventId || 'quarantine'}:${entry.timestamp || entry.queuedAt || Date.now()}`,
    })),
    unitRoutes: Object.fromEntries(
      (snapshot.units || [])
        .filter(unit => unit.currentRoute?.path?.length)
        .map(unit => [
          unit.id,
          {
            ...unit.currentRoute,
            unitId: unit.id,
            unitType: unit.type,
            unitName: unit.name,
            path: normalizeRoutePath(unit.currentRoute.path),
          },
        ]),
    ),
    stats:        snapshot.stats          || {},
  }),

  updateStats: stats => set({ stats }),

  upsertUnit: unit => set(state => ({
    units: state.units.some(u => u.id === unit.id)
      ? state.units.map(u => u.id === unit.id ? { ...u, ...unit } : u)
      : [...state.units, unit],
  })),

  addIncident: incident => set(state => {
    const descriptionKey = (incident.description || '').slice(0, 50).trim().toLowerCase();
    if (state.eventFeed.some(e =>
      e.id === incident.id ||
      (descriptionKey && (e.description || '').slice(0, 50).trim().toLowerCase() === descriptionKey)
    )) {
      return {};
    }
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
  startThought: ({ agentId, incidentId, eventType, zone }) => {
    const base = baseId(incidentId);
    set(state => {
      // If there's an active thought for the same base incident, just reset it
      if (state.activeThought && baseId(state.activeThought.incidentId) === base) {
        return {
          activeThought: {
            ...state.activeThought,
            incidentId,
            eventType: eventType || state.activeThought.eventType || null,
            zone: zone || state.activeThought.zone || null,
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
          eventType: eventType || null,
          zone: zone || null,
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
        // Extract clean summary at archive time — pill reads this directly
        const tools     = updated.toolCalls || [];
        const dispatched = tools.filter(t =>
          (t.tool === 'dispatchUnit' || t.name === 'dispatchUnit') && t.result?.success
        );
        const blocked = tools.filter(t =>
          (t.tool === 'blockRoad' || t.name === 'blockRoad') && t.result?.success
        );
        const routed = tools.filter(t =>
          (t.tool === 'getRoute' || t.name === 'getRoute') && t.result?.success
        );
        const hospitals = tools.filter(t =>
          (t.tool === 'getHospitalCapacity' || t.name === 'getHospitalCapacity') && t.result?.success
        );

        // Extract incident type + zone from opening line of token stream
        // Format: "[LIVE NEWS] STRUCTURAL FIRE in LN — Priority 8/10"
        //      or "[DEMO] INFRASTRUCTURE FAILURE in CP — Priority 10/10"
        const firstLine  = updated.tokens.split('\n')[0] || '';
        const typeZone   = firstLine.replace(/^\[[^\]]+\]\s*/,''); // strip [SOURCE] prefix
        const zoneMatch  = typeZone.match(/\bin\s+([A-Z]{2,3})\b/);
        const zone       = updated.zone || (zoneMatch ? zoneMatch[1] : null);
        const typeRaw    = typeZone.replace(/\s*—.*$/,'').replace(/\bin\s+[A-Z]{2,3}.*/,'').trim();
        const typeFmt    = (updated.eventType || typeRaw).toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).slice(0,28);

        // Build human-readable summary line
        let summary;
        if (dispatched.length > 0) {
          const unitNames = dispatched
            .map(d => d.result?.unit?.name || d.args?.unitId || 'unit')
            .slice(0, 2)
            .join(', ');
          summary = `${dispatched.length} unit${dispatched.length > 1 ? 's' : ''} dispatched — ${unitNames}`;
        } else if (blocked.length > 0) {
          summary = `Road closed — ${blocked[0].result?.edgeName || 'route blocked'}`;
        } else if (routed.length > 0 && hospitals.length > 0) {
          summary = `Assessed — routed to ${hospitals[0].result?.recommendation?.split(':')[1]?.trim()?.slice(0,20) || 'hospital'}`;
        } else if (tools.length > 0) {
          summary = `Assessed — ${tools.length} action${tools.length > 1 ? 's' : ''}, no dispatch needed`;
        } else {
          summary = 'Assessed — no units required';
        }

        const archived = {
          ...updated,
          _summary:     summary,
          _type:        typeFmt || 'Incident',
          _zone:        zone,
          _dispatched:  dispatched.length,
          _blocked:     blocked.length,
          _toolCount:   tools.length,
          _completedAt: new Date().toISOString(),
        };

        return {
          activeThought: null,
          thoughtHistory: [archived, ...state.thoughtHistory].slice(0, 5),
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
    const key = securityEventKey(ev);
    const nextEvent = {
      ...ev,
      _key: key || `${ev.eventType || 'security'}-${Date.now()}`,
    };

    if (key) {
      const idx = state.securityFeed.findIndex(existing => securityEventKey(existing) === key);
      if (idx !== -1) {
        const list = [...state.securityFeed];
        list[idx] = { ...list[idx], ...nextEvent };
        return { securityFeed: list };
      }
    }

    return {
      securityFeed: [nextEvent, ...state.securityFeed].slice(0, 15),
    };
  }),

  // ── Audit — one entry per base incident, always update not duplicate ───────
  addAuditEntry: entry => set(state => {
    const base = baseId(entry.incidentId);
    const idx  = state.auditTimeline.findIndex(e => baseId(e.incidentId) === base);
    const existing = idx !== -1 ? state.auditTimeline[idx] : null;
    const incomingTools = entry.toolCalls || [];
    const existingTools = existing?.toolCalls || [];
    const incomingDecision = entry.decision || '';
    const existingDecision = existing?.decision || '';

    const merged = {
      ...existing,
      ...entry,
      incidentId: base,
      toolCalls: incomingTools.length >= existingTools.length ? incomingTools : existingTools,
      decision: isMeaningfulDecision(incomingDecision)
        ? incomingDecision
        : isMeaningfulDecision(existingDecision)
          ? existingDecision
          : incomingDecision || existingDecision,
      updatedAt: new Date().toISOString(),
      timestamp: entry.timestamp || existing?.timestamp || new Date().toISOString(),
    };

    if (idx !== -1) {
      const list = [...state.auditTimeline];
      list[idx] = { ...list[idx], ...merged };
      return { auditTimeline: list };
    }
    return { auditTimeline: [merged, ...state.auditTimeline].slice(0, 15) };
  }),

  setUnitRoute: route => set(s => ({
    unitRoutes: {
      ...s.unitRoutes,
      [route.unitId]: {
        ...route,
        path: normalizeRoutePath(route.path),
      },
    },
  })),

  clearUnitRoute: unitId => set(s => {
    const next = { ...s.unitRoutes };
    delete next[unitId];
    return { unitRoutes: next };
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
    unitRoutes:     {},
  }),
}));
