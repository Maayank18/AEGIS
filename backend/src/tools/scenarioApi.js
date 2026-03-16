import { Router } from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { eventQueue } from '../core/eventQueue.js';
import { worldState } from '../core/worldState.js';
import { logger } from '../utils/logger.js';
import { broadcast } from '../utils/broadcast.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedEvents = JSON.parse(readFileSync(join(__dirname, '../data/seedEvents.json'), 'utf-8'));

const router = Router();

// GET /api/scenarios — list all scenarios for JudgePanel
router.get('/', (req, res) => {
  res.json({
    success: true,
    scenarios: seedEvents.map(s => ({
      id: s.id, name: s.name, description: s.description,
      type: s.type, zone: s.zone, priority: s.priority,
    })),
  });
});

// POST /api/scenarios/trigger/:scenarioId — fire a scenario
// IMPORTANT: do NOT pre-block roads here. Let the AI coordinator
// call blockRoad() as a tool so the reasoning is visible in ThoughtTrace.
router.post('/trigger/:scenarioId', (req, res) => {
  const scenario = seedEvents.find(s => s.id === req.params.scenarioId);
  if (!scenario) {
    return res.status(404).json({ success: false, error: `Scenario '${req.params.scenarioId}' not found` });
  }

  const event = {
    ...scenario.event,
    id: `${scenario.id}-${uuidv4().slice(0, 6)}`,
    _scenario: scenario.id,
  };

  // NOTE: No pre-trigger blockRoad here — the coordinator handles this via tools.
  // This ensures the bridge collapse reasoning appears live in the AI Thought Stream.

  eventQueue.enqueue(event);

  broadcast({
    type: 'SCENARIO_TRIGGERED',
    payload: {
      scenarioId:   scenario.id,
      scenarioName: scenario.name,
      eventId:      event.id,
      zone:         event.zone,
      priority:     event.priority,
      timestamp:    new Date().toISOString(),
    },
  });

  logger.success(`🎬 Scenario triggered: "${scenario.name}" (${event.id})`);

  res.json({
    success: true,
    message: `Scenario "${scenario.name}" injected into event queue`,
    eventId: event.id,
    queueSize: eventQueue.size,
  });
});

// POST /api/scenarios/custom — inject custom event
router.post('/custom', (req, res) => {
  const { type, subtype, zone, priority, description } = req.body;
  if (!type || !zone || !priority || !description) {
    return res.status(400).json({ success: false, error: 'Required: type, zone, priority, description' });
  }
  const event = {
    id: `custom-${uuidv4().slice(0, 8)}`,
    type, subtype: subtype || null, zone,
    priority: Math.min(10, Math.max(1, parseInt(priority))),
    description, _source: 'custom_injection',
  };
  eventQueue.enqueue(event);
  res.json({ success: true, message: 'Custom event injected', eventId: event.id, queueSize: eventQueue.size });
});

// GET /api/scenarios/state — current world state snapshot
router.get('/state', (req, res) => {
  res.json({
    success: true,
    snapshot: worldState.getSnapshot(),
    queue: { size: eventQueue.size, events: eventQueue.getAll() },
  });
});

// POST /api/scenarios/reset — reset everything for clean demo
router.post('/reset', (req, res) => {
  worldState.getUnitsByStatus('dispatched').forEach(u => worldState.returnUnit(u.id));
  worldState.getBlockedEdges().forEach(edgeId => worldState.unblockEdge(edgeId));
  worldState.getActiveIncidents().forEach(i => worldState.resolveIncident(i.id));
  eventQueue.clear();
  broadcast({ type: 'SYSTEM_RESET', payload: { timestamp: new Date().toISOString() } });
  logger.success('System reset complete');
  res.json({ success: true, message: 'System reset — all units available', stats: worldState.getStats() });
});

export default router;