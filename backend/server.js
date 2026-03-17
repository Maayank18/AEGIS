/*
 * Why changed: expose quarantine memory state and a direct simulation endpoint so security and routing checks hit the same server ingress used in the demo.
 * Security rationale: operators can verify blocked events and route frames even if MongoDB is unavailable.
 */
/**
 * AEGIS — Autonomous Emergency Grid Intelligence System
 * ─────────────────────────────────────────────────────────────────────────────
 * Main server: Express REST API + WebSocket server + startup orchestration.
 *
 * Startup sequence:
 *   1. Connect MongoDB (non-fatal if unavailable)
 *   2. Initialize WorldState with seed data
 *   3. Start Replan Engine (threshold watcher)
 *   4. Start Hospital Simulator (45s bed fluctuation)
 *   5. Start Express + WebSocket servers
 *   6. Start Live News Feed (90s Delhi news polling)
 *   7. Start Coordinator Agent loop (infinite event consumer)
 */

import express from 'express';
import cors    from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import mongoose from 'mongoose';

import { worldState }          from './src/core/worldState.js';
import { eventQueue }          from './src/core/eventQueue.js';
import { initReplanEngine }    from './src/core/replanEngine.js';
import { startHospitalSimulator } from './src/core/hospitalSimulator.js';
import { startLiveNewsFeed, getNewsFeedStats } from './src/core/liveNewsFeed.js';
import { startCoordinatorLoop } from './src/agents/coordinator.js';
import { setBroadcast, broadcast } from './src/utils/broadcast.js';
import { logger }              from './src/utils/logger.js';
import { PORT, WS_PORT, MONGO_URI, FRONTEND_URL } from './src/config.js';
import scenarioRouter          from './src/tools/scenarioApi.js';

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();

app.use(cors({
  origin:  [FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'OPTIONS'],
}));
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api/scenarios', scenarioRouter);

// Health check — full system status
app.get('/api/health', (req, res) => {
  res.json({
    status:    'online',
    system:    'AEGIS',
    version:   '2.0.0',
    timestamp: new Date().toISOString(),
    stats:     worldState.getStats(),
    queue:     { size: eventQueue.size, pending: eventQueue.getAll().length },
    ws:        { clients: wss?.clients?.size ?? 0 },
    newsFeed:  getNewsFeedStats(),
    hospitals: worldState.getAllHospitals().map(h => ({
      id: h.id, name: h.name,
      availableBeds: h.availableBeds, availableIcu: h.availableIcu,
    })),
  });
});

// Audit log endpoint
app.get('/api/audit', async (req, res) => {
  try {
    const { AuditEntry } = await import('./src/models/AuditEntry.js');
    const entries = await AuditEntry
      .find({})
      .sort({ createdAt: -1 })
      .limit(parseInt(req.query.limit) || 50)
      .lean();
    res.json({ success: true, count: entries.length, entries });
  } catch (err) {
    // MongoDB not available — return empty
    res.json({ success: true, count: 0, entries: [], note: 'MongoDB not connected' });
  }
});

// News feed stats
app.get('/api/news/stats', (req, res) => {
  res.json({ success: true, ...getNewsFeedStats() });
});

app.get('/api/security/quarantine', (req, res) => {
  res.json({
    success: true,
    count: worldState.getQuarantineQueue().length,
    entries: worldState.getQuarantineQueue(),
  });
});

app.post('/api/simulate/event', (req, res) => {
  const event = {
    ...req.body,
    id: req.body.id || `sim-${Date.now()}`,
    _source: req.body._source || 'manual_simulation',
  };

  if (!event.type || !event.description) {
    return res.status(400).json({ success: false, error: 'Required: type, description' });
  }

  eventQueue.enqueue(event);
  res.json({ success: true, eventId: event.id, queueSize: eventQueue.size });
});

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: WS_PORT });

// Wire broadcast helper → WS clients
setBroadcast((data) => {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch { /* client disconnected mid-send */ }
    }
  });
});

wss.on('connection', (ws, req) => {
  logger.info(`WS client connected (total: ${wss.clients.size})`);

  // Bootstrap frontend with full current state on connect
  try {
    ws.send(JSON.stringify({
      type:    'INITIAL_STATE',
      payload: worldState.getSnapshot(),
      _ts:     Date.now(),
    }));
  } catch { /* send may fail if client disconnects immediately */ }

  ws.on('close', () => logger.info(`WS client disconnected (remaining: ${wss.clients.size - 1})`));
  ws.on('error', (err) => logger.warn('WS client error:', err.message));
});

// Forward all WorldState changes → WS broadcast
worldState.on('stateChange', ({ type, payload }) => {
  broadcast({ type, payload });
});

// ─── MongoDB ──────────────────────────────────────────────────────────────────

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
    logger.success(`MongoDB connected`);
  } catch (err) {
    logger.warn(`MongoDB unavailable — running without persistent audit log`);
    logger.warn(`  (This is fine for the demo — all features work without MongoDB)`);
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   AEGIS — Autonomous Emergency Grid Intelligence      ║');
  console.log('║   National Level Agentic AI Hackathon — ByteForce     ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // 1. Database (non-blocking)
  await connectDB();

  // 2. Core state
  worldState.init();

  // 3. Replan engine
  initReplanEngine();

  // 4. Hospital simulator (live bed fluctuation)
  startHospitalSimulator();

  // 5. HTTP + WebSocket servers
  app.listen(PORT, () => {
    logger.success(`HTTP server  →  http://localhost:${PORT}`);
    logger.info(`  Health:    http://localhost:${PORT}/api/health`);
    logger.info(`  Scenarios: http://localhost:${PORT}/api/scenarios`);
    logger.info(`  News feed: http://localhost:${PORT}/api/news/stats`);
  });
  logger.success(`WebSocket    →  ws://localhost:${WS_PORT}`);

  // 6. Live news feed (starts after 5s to let WS clients connect first)
  setTimeout(() => {
    startLiveNewsFeed().catch(err => {
      logger.warn(`News feed failed to start: ${err.message}`);
    });
  }, 5000);

  // 7. Coordinator loop (infinite)
  logger.success('Coordinator  →  agent loop active\n');
  startCoordinatorLoop();
}

start().catch(err => {
  logger.error('FATAL startup error:', err.message);
  process.exit(1);
});
