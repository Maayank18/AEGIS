import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dirname, '../data');

// ─── WorldState ───────────────────────────────────────────────────────────────
// Single source of truth for ALL live city state.
// Every agent reads from here; every tool mutates here.
// Changes are broadcast via EventEmitter so the WS layer picks them up.
// ─────────────────────────────────────────────────────────────────────────────

class WorldState extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // multiple agents + server listen

    this._units      = new Map(); // unitId → unit object
    this._incidents  = new Map(); // incidentId → incident object
    this._hospitals  = new Map(); // hospitalId → hospital object
    this._cityGraph  = null;      // { nodes: [], edges: [] }
    this._blockedEdges = new Set(); // set of blocked edge IDs

    this._stats = {
      totalEventsProcessed: 0,
      totalReplans: 0,
      totalInjectionsCaught: 0,
      uptime: Date.now(),
    };

    this._initialized = false;
  }

  // ── Initialization ──────────────────────────────────────────────────────────

  init() {
    if (this._initialized) return this;

    const load = (file) => JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8'));

    try {
      const units     = load('seedUnits.json');
      const hospitals = load('seedHospitals.json');
      const graph     = load('cityGraph.json');

      units.forEach(u => this._units.set(u.id, { ...u }));
      hospitals.forEach(h => this._hospitals.set(h.id, {
        ...h,
        updatedAt: new Date().toISOString(),
      }));
      this._cityGraph = graph;
      this._initialized = true;

      logger.success(`WorldState initialized — ${units.length} units, ${hospitals.length} hospitals, ${graph.nodes.length} zones, ${graph.edges.length} roads`);
      this.emit('initialized', this.getSnapshot());
      return this;
    } catch (err) {
      logger.error('WorldState init failed:', err.message);
      throw err;
    }
  }

  // ── Units ───────────────────────────────────────────────────────────────────

  getUnit(id) {
    return this._units.get(id) || null;
  }

  getAllUnits() {
    return Array.from(this._units.values());
  }

  /**
   * Get available units, optionally filtered by type and/or zone.
   * Used by the coordinator to find units to dispatch.
   */
  getAvailableUnits(type = null, zone = null) {
    return Array.from(this._units.values()).filter(u => {
      if (u.status !== 'available') return false;
      if (type && u.type !== type) return false;
      if (zone && u.currentZone !== zone) return false;
      return true;
    });
  }

  getUnitsByStatus(status) {
    return Array.from(this._units.values()).filter(u => u.status === status);
  }

  /**
   * Dispatch a unit to a destination for an incident.
   * Throws if unit not found or not available.
   */
  dispatchUnit(unitId, destination, incidentId) {
    const unit = this._units.get(unitId);
    if (!unit) throw new Error(`Unit ${unitId} not found`);
    if (unit.status !== 'available') {
      throw new Error(`Unit ${unitId} (${unit.name}) is not available — current status: ${unit.status}`);
    }

    unit.status      = 'dispatched';
    unit.destination = destination;
    unit.incidentId  = incidentId;
    unit.dispatchedAt = new Date().toISOString();

    const snapshot = { ...unit };
    this.emit('unitDispatched', snapshot);
    this._broadcastStateChange('UNIT_DISPATCHED', snapshot);
    logger.agent('system', `Dispatched ${unit.name} → ${destination} for incident ${incidentId}`);
    return snapshot;
  }

  /**
   * Return a unit to available status.
   * Called after incident resolution or when replanning recalls en-route units.
   */
  returnUnit(unitId) {
    const unit = this._units.get(unitId);
    if (!unit) throw new Error(`Unit ${unitId} not found`);

    unit.status      = 'available';
    unit.destination = null;
    unit.incidentId  = null;
    unit.returnedAt  = new Date().toISOString();

    const snapshot = { ...unit };
    this.emit('unitReturned', snapshot);
    this._broadcastStateChange('UNIT_RETURNED', snapshot);
    return snapshot;
  }

  /** Move a unit to a new zone (called when it arrives at destination) */
  updateUnitZone(unitId, newZone) {
    const unit = this._units.get(unitId);
    if (!unit) throw new Error(`Unit ${unitId} not found`);
    unit.currentZone = newZone;
    this._broadcastStateChange('UNIT_ZONE_UPDATED', { ...unit });
    return { ...unit };
  }

  // ── Incidents ───────────────────────────────────────────────────────────────

  createIncident(data) {
    const incident = {
      id: data.id || uuidv4(),
      type: data.type,
      subtype: data.subtype || null,
      zone: data.zone,
      priority: data.priority,
      description: data.description,
      status: 'active',
      unitsDispatched: [],
      metadata: data.metadata || data,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this._incidents.set(incident.id, incident);
    this._stats.totalEventsProcessed++;
    this.emit('incidentCreated', { ...incident });
    this._broadcastStateChange('INCIDENT_CREATED', { ...incident });
    return { ...incident };
  }

  updateIncident(id, updates) {
    const incident = this._incidents.get(id);
    if (!incident) throw new Error(`Incident ${id} not found`);
    Object.assign(incident, updates, { updatedAt: new Date().toISOString() });
    this._broadcastStateChange('INCIDENT_UPDATED', { ...incident });
    return { ...incident };
  }

  resolveIncident(id) {
    return this.updateIncident(id, { status: 'resolved', resolvedAt: new Date().toISOString() });
  }

  getIncident(id)          { return this._incidents.get(id) || null; }
  getAllIncidents()         { return Array.from(this._incidents.values()); }
  getActiveIncidents()     { return Array.from(this._incidents.values()).filter(i => i.status === 'active'); }

  // ── Hospitals ───────────────────────────────────────────────────────────────

  getHospital(id)     { return this._hospitals.get(id) || null; }
  getAllHospitals()    { return Array.from(this._hospitals.values()); }

  updateHospitalCapacity(hospitalId, availableBeds, availableIcu = null) {
    const h = this._hospitals.get(hospitalId);
    if (!h) throw new Error(`Hospital ${hospitalId} not found`);
    h.availableBeds = availableBeds;
    if (availableIcu !== null) h.availableIcu = availableIcu;
    h.updatedAt = new Date().toISOString();
    this._broadcastStateChange('HOSPITAL_UPDATED', { ...h });
    return { ...h };
  }

  // ── City Graph / Roads ──────────────────────────────────────────────────────

  getCityGraph()     { return this._cityGraph; }
  getBlockedEdges()  { return Array.from(this._blockedEdges); }

  /**
   * Block a road/bridge edge — sets weight to Infinity in the graph.
   * The routing tool rebuilds the graph on each call so this takes effect immediately.
   */
  blockEdge(edgeId) {
    if (this._blockedEdges.has(edgeId)) {
      return { alreadyBlocked: true, edgeId };
    }

    this._blockedEdges.add(edgeId);

    const edge = this._cityGraph?.edges.find(e => e.id === edgeId);
    if (edge) {
      edge._originalWeight = edge.weight;
      edge.weight  = 999999;
      edge.blocked = true;
    }

    this.emit('edgeBlocked', { edgeId, edge });
    this._broadcastStateChange('EDGE_BLOCKED', { edgeId, edgeName: edge?.name });
    logger.warn(`🚧 Road blocked: ${edge?.name || edgeId} (${edge?.from} ↔ ${edge?.to})`);

    // Trigger replan — imported lazily to avoid circular dep
    this.emit('replanNeeded', {
      reason: `Road blocked: ${edge?.name || edgeId}`,
      blockedEdge: edgeId,
    });

    return { edgeId, edge };
  }

  unblockEdge(edgeId) {
    this._blockedEdges.delete(edgeId);
    const edge = this._cityGraph?.edges.find(e => e.id === edgeId);
    if (edge && edge._originalWeight !== undefined) {
      edge.weight  = edge._originalWeight;
      edge.blocked = false;
    }
    this._broadcastStateChange('EDGE_UNBLOCKED', { edgeId });
  }

  // ── Stats & Snapshots ────────────────────────────────────────────────────────

  incrementStat(key) {
    if (key in this._stats) this._stats[key]++;
  }

  getStats() {
    const units = this.getAllUnits();
    return {
      ...this._stats,
      uptimeSeconds: Math.floor((Date.now() - this._stats.uptime) / 1000),
      totalUnits: units.length,
      availableUnits: units.filter(u => u.status === 'available').length,
      dispatchedUnits: units.filter(u => u.status === 'dispatched').length,
      activeIncidents: this.getActiveIncidents().length,
      blockedRoads: this._blockedEdges.size,
    };
  }

  /**
   * Full state snapshot — passed to coordinator as context on every ReAct call.
   */
  getSnapshot() {
    return {
      timestamp: new Date().toISOString(),
      units: this.getAllUnits(),
      activeIncidents: this.getActiveIncidents(),
      hospitals: this.getAllHospitals(),
      blockedEdges: this.getBlockedEdges(),
      stats: this.getStats(),
    };
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  _broadcastStateChange(type, payload) {
    // broadcast module listens to this; import is done in server.js
    this.emit('stateChange', { type, payload });
  }
}

// Export singleton — the single shared instance for the entire backend
export const worldState = new WorldState();