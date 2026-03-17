/*
 * Why changed: keep route state and a capped in-memory quarantine queue available even when persistence fails.
 * Security rationale: blocked events and reroute metadata remain visible to the UI immediately instead of depending on MongoDB writes.
 */
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');

class WorldState extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);

    this._units = new Map();
    this._incidents = new Map();
    this._hospitals = new Map();
    this._cityGraph = null;
    this._blockedEdges = new Set();
    this._quarantineQueue = [];

    this._stats = {
      totalEventsProcessed: 0,
      totalReplans: 0,
      totalInjectionsCaught: 0,
      uptime: Date.now(),
    };

    this._initialized = false;
  }

  init() {
    if (this._initialized) {
      return this;
    }

    const load = file => JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8'));

    try {
      const units = load('seedUnits.json');
      const hospitals = load('seedHospitals.json');
      const graph = load('cityGraph.json');

      units.forEach(unit => this._units.set(unit.id, { ...unit, currentRoute: null }));
      hospitals.forEach(hospital => this._hospitals.set(hospital.id, {
        ...hospital,
        updatedAt: new Date().toISOString(),
      }));
      this._cityGraph = graph;
      this._initialized = true;

      logger.success(
        `WorldState initialized - ${units.length} units, ${hospitals.length} hospitals, ${graph.nodes.length} zones, ${graph.edges.length} roads`,
      );
      this.emit('initialized', this.getSnapshot());
      return this;
    } catch (err) {
      logger.error('WorldState init failed:', err.message);
      throw err;
    }
  }

  getUnit(id) {
    return this._units.get(id) || null;
  }

  getAllUnits() {
    return Array.from(this._units.values());
  }

  getAvailableUnits(type = null, zone = null) {
    return Array.from(this._units.values()).filter(unit => {
      if (unit.status !== 'available') return false;
      if (type && unit.type !== type) return false;
      if (zone && unit.currentZone !== zone) return false;
      return true;
    });
  }

  getUnitsByStatus(status) {
    return Array.from(this._units.values()).filter(unit => unit.status === status);
  }

  dispatchUnit(unitId, destination, incidentId) {
    const unit = this._units.get(unitId);
    if (!unit) throw new Error(`Unit ${unitId} not found`);
    if (unit.status !== 'available') {
      throw new Error(`Unit ${unitId} (${unit.name}) is not available - current status: ${unit.status}`);
    }

    unit.status = 'dispatched';
    unit.destination = destination;
    unit.incidentId = incidentId;
    unit.currentRoute = null;
    unit.dispatchedAt = new Date().toISOString();

    const snapshot = { ...unit };
    this.emit('unitDispatched', snapshot);
    this._broadcastStateChange('UNIT_DISPATCHED', snapshot);
    logger.agent('system', `Dispatched ${unit.name} -> ${destination} for incident ${incidentId}`);
    return snapshot;
  }

  returnUnit(unitId) {
    const unit = this._units.get(unitId);
    if (!unit) throw new Error(`Unit ${unitId} not found`);

    unit.status = 'available';
    unit.destination = null;
    unit.incidentId = null;
    unit.currentRoute = null;
    unit.returnedAt = new Date().toISOString();

    const snapshot = { ...unit };
    this.emit('unitReturned', snapshot);
    this._broadcastStateChange('UNIT_RETURNED', snapshot);
    return snapshot;
  }

  updateUnitZone(unitId, newZone) {
    const unit = this._units.get(unitId);
    if (!unit) throw new Error(`Unit ${unitId} not found`);
    unit.currentZone = newZone;
    const snapshot = { ...unit };
    this._broadcastStateChange('UNIT_ZONE_UPDATED', snapshot);
    return snapshot;
  }

  setUnitRoute(unitId, route) {
    const unit = this._units.get(unitId);
    if (!unit) throw new Error(`Unit ${unitId} not found`);
    unit.currentRoute = route;
    unit.routeUpdatedAt = new Date().toISOString();
    const snapshot = { ...unit };
    logger.info(`[UNIT_UPDATE] unitId=${unitId} destination=${unit.destination || 'n/a'} routePoints=${route?.path?.length || 0}`);
    this._broadcastStateChange('UNIT_UPDATE', snapshot);
    return snapshot;
  }

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

  getIncident(id) {
    return this._incidents.get(id) || null;
  }

  getAllIncidents() {
    return Array.from(this._incidents.values());
  }

  getActiveIncidents() {
    return Array.from(this._incidents.values()).filter(incident => incident.status === 'active');
  }

  getHospital(id) {
    return this._hospitals.get(id) || null;
  }

  getAllHospitals() {
    return Array.from(this._hospitals.values());
  }

  updateHospitalCapacity(hospitalId, availableBeds, availableIcu = null) {
    const hospital = this._hospitals.get(hospitalId);
    if (!hospital) throw new Error(`Hospital ${hospitalId} not found`);
    hospital.availableBeds = availableBeds;
    if (availableIcu !== null) hospital.availableIcu = availableIcu;
    hospital.updatedAt = new Date().toISOString();
    this._broadcastStateChange('HOSPITAL_UPDATED', { ...hospital });
    return { ...hospital };
  }

  getCityGraph() {
    return this._cityGraph;
  }

  getBlockedEdges() {
    return Array.from(this._blockedEdges);
  }

  blockEdge(edgeId) {
    if (this._blockedEdges.has(edgeId)) {
      return { alreadyBlocked: true, edgeId };
    }

    this._blockedEdges.add(edgeId);

    const edge = this._cityGraph?.edges.find(candidate => candidate.id === edgeId);
    if (edge) {
      edge._originalWeight = edge.weight;
      edge.weight = 999999;
      edge.blocked = true;
    }

    this.emit('edgeBlocked', { edgeId, edge });
    this._broadcastStateChange('EDGE_BLOCKED', { edgeId, edgeName: edge?.name });
    logger.warn(`Road blocked: ${edge?.name || edgeId} (${edge?.from} <-> ${edge?.to})`);

    this.emit('replanNeeded', {
      reason: `Road blocked: ${edge?.name || edgeId}`,
      blockedEdge: edgeId,
    });

    return { edgeId, edge };
  }

  unblockEdge(edgeId) {
    this._blockedEdges.delete(edgeId);
    const edge = this._cityGraph?.edges.find(candidate => candidate.id === edgeId);
    if (edge && edge._originalWeight !== undefined) {
      edge.weight = edge._originalWeight;
      edge.blocked = false;
    }
    this._broadcastStateChange('EDGE_UNBLOCKED', { edgeId });
  }

  pushQuarantine(entry) {
    const enriched = {
      ...entry,
      persisted: entry.persisted ?? false,
      queuedAt: entry.queuedAt || new Date().toISOString(),
    };

    this._quarantineQueue = [
      enriched,
      ...this._quarantineQueue.filter(existing => existing.eventId !== enriched.eventId),
    ].slice(0, 50);

    this._broadcastStateChange('QUARANTINE_UPDATED', enriched);
    return enriched;
  }

  markQuarantinePersisted(eventId, persisted = true, error = null) {
    this._quarantineQueue = this._quarantineQueue.map(entry =>
      entry.eventId === eventId
        ? {
            ...entry,
            persisted,
            persistError: error,
            persistedAt: persisted ? new Date().toISOString() : entry.persistedAt,
          }
        : entry,
    );

    const updated = this._quarantineQueue.find(entry => entry.eventId === eventId);
    if (updated) {
      this._broadcastStateChange('QUARANTINE_UPDATED', updated);
    }
    return updated || null;
  }

  getQuarantineQueue() {
    return [...this._quarantineQueue];
  }

  clearQuarantineQueue() {
    this._quarantineQueue = [];
  }

  incrementStat(key) {
    if (key in this._stats) this._stats[key]++;
  }

  getStats() {
    const units = this.getAllUnits();
    return {
      ...this._stats,
      uptimeSeconds: Math.floor((Date.now() - this._stats.uptime) / 1000),
      totalUnits: units.length,
      availableUnits: units.filter(unit => unit.status === 'available').length,
      dispatchedUnits: units.filter(unit => unit.status === 'dispatched').length,
      activeIncidents: this.getActiveIncidents().length,
      blockedRoads: this._blockedEdges.size,
      quarantinedEvents: this._quarantineQueue.length,
    };
  }

  getSnapshot() {
    return {
      timestamp: new Date().toISOString(),
      units: this.getAllUnits(),
      activeIncidents: this.getActiveIncidents(),
      hospitals: this.getAllHospitals(),
      blockedEdges: this.getBlockedEdges(),
      quarantineQueue: this.getQuarantineQueue(),
      stats: this.getStats(),
    };
  }

  _broadcastStateChange(type, payload) {
    this.emit('stateChange', { type, payload });
  }
}

export const worldState = new WorldState();
