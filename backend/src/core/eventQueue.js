import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';

// ─── Priority Event Queue ──────────────────────────────────────────────────────
// Min-heap by priority (higher number = higher urgency = processed first).
// The coordinator dequeues from here in a continuous async loop.
//
// Priority scale:
//   10 — Mass casualty / infrastructure collapse (immediate)
//    8 — Major fire / multi-car accident
//    6 — Robbery / medical emergency
//    4 — Minor incidents
//    1 — Low-priority calls / informational
// ─────────────────────────────────────────────────────────────────────────────

class EventQueue extends EventEmitter {
  constructor() {
    super();
    this._queue      = [];  // sorted descending by priority
    this._processing = false;
    this._waiters    = [];  // resolve functions waiting for next item
  }

  /**
   * Add an event to the queue, inserting at the correct priority position.
   * Higher priority items are served first regardless of arrival order.
   */
  enqueue(event) {
    const item = {
      id:          event.id || `evt-${uuidv4().slice(0, 8)}`,
      type:        event.type        || 'unknown',
      subtype:     event.subtype     || null,
      zone:        event.zone        || 'CP',
      priority:    event.priority    || 5,
      description: event.description || '',
      metadata:    event.metadata    || event,
      enqueuedAt:  new Date().toISOString(),
    };

    // Insert maintaining descending priority order (O(n) — fine for hackathon scale)
    const insertIdx = this._queue.findIndex(e => e.priority < item.priority);
    if (insertIdx === -1) {
      this._queue.push(item);
    } else {
      this._queue.splice(insertIdx, 0, item);
    }

    logger.info(`📥 Enqueued [priority:${item.priority}] ${item.type}${item.subtype ? `/${item.subtype}` : ''} in ${item.zone} — queue size: ${this._queue.length}`);
    this.emit('enqueued', item);

    // Wake up any waiting dequeue() promises
    if (this._waiters.length > 0) {
      const resolve = this._waiters.shift();
      resolve(this._queue.shift());
    }

    return item;
  }

  /**
   * Dequeue the highest-priority item.
   * If the queue is empty, waits (async) until an item arrives.
   * This lets the coordinator loop run as `while(true) { const e = await queue.dequeue(); ... }`
   */
  dequeue() {
    if (this._queue.length > 0) {
      return Promise.resolve(this._queue.shift());
    }
    // Queue empty — return a promise that resolves when something arrives
    return new Promise(resolve => {
      this._waiters.push(resolve);
    });
  }

  /** Non-blocking peek at the next item (returns null if empty) */
  peek() {
    return this._queue[0] || null;
  }

  /** Requeue all active incidents — used by the replan engine */
  requeueIncidents(incidents) {
    let count = 0;
    for (const incident of incidents) {
      this.enqueue({
        ...incident,
        id: `replan-${incident.id}`,
        priority: Math.min(incident.priority + 1, 10), // bump priority on replan
        _isReplan: true,
      });
      count++;
    }
    logger.warn(`♻️  Replan: re-queued ${count} active incidents`);
    return count;
  }

  get size()    { return this._queue.length; }
  get isEmpty() { return this._queue.length === 0; }
  getAll()      { return [...this._queue]; }
  clear()       { this._queue = []; this._waiters = []; }
}

// Singleton — imported by coordinator and scenarioApi
export const eventQueue = new EventQueue();