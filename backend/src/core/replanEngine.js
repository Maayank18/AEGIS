/**
 * AEGIS Replan Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Watches WorldState events and decides when to re-queue active incidents.
 * The coordinator re-processes them with the latest city state.
 *
 * Triggers:
 *   1. Road blocked (bridge collapse) — always replan, immediately
 *   2. Available units drop below 30% — replan to redistribute
 *
 * Intentionally NOT triggered by new critical events — that caused
 * phantom replans when no other incidents existed. The coordinator
 * handles new events directly; replan only fires for EXISTING incidents
 * that need to be re-evaluated due to changed conditions.
 */

import { worldState } from './worldState.js';
import { eventQueue } from './eventQueue.js';
import { logger } from '../utils/logger.js';
import { broadcastReplan } from '../utils/broadcast.js';
import { REPLAN_THRESHOLDS } from '../config.js';

const REPLAN_COOLDOWN_MS = 8000; // hard minimum between replans — prevents storms
let   _lastReplanAt      = 0;

export function initReplanEngine() {
  // Trigger 1 — Road blocked
  worldState.on('replanNeeded', ({ reason, blockedEdge }) => {
    // Only replan if there are ACTIVE incidents that might be affected
    const active = worldState.getActiveIncidents();
    if (active.length === 0) {
      logger.info('Replan skipped — road blocked but no active incidents to reroute');
      return;
    }
    triggerReplan(`🚧 ${reason}`, { blockedEdge });
  });

  // Trigger 2 — Unit saturation
  worldState.on('unitDispatched', () => {
    checkUnitThreshold();
  });

  logger.success('Replan engine initialized — road blocks + saturation threshold active');
}

/**
 * Core replan: re-queues all active incidents so coordinator re-evaluates
 * with the current city state (new routes, available units, blocked roads).
 */
function triggerReplan(reason, metadata = {}) {
  const now = Date.now();

  if (now - _lastReplanAt < REPLAN_COOLDOWN_MS) {
    const remaining = Math.round((REPLAN_COOLDOWN_MS - (now - _lastReplanAt)) / 1000);
    logger.warn(`Replan suppressed (cooldown: ${remaining}s remaining)`);
    return;
  }

  const activeIncidents = worldState.getActiveIncidents();
  if (activeIncidents.length === 0) {
    logger.info('Replan triggered but no active incidents to re-queue');
    return;
  }

  _lastReplanAt = now;
  worldState.incrementStat('totalReplans');

  logger.warn(`🔄 REPLAN: ${reason} — re-queuing ${activeIncidents.length} incident(s)`);
  broadcastReplan(reason, activeIncidents.map(i => i.id));

  const count = eventQueue.requeueIncidents(activeIncidents);
  logger.warn(`🔄 Replan complete: ${count} incident(s) re-queued for re-evaluation`);

  return { triggered: true, reason, requeuedCount: count };
}

function checkUnitThreshold() {
  const stats        = worldState.getStats();
  const available    = stats.availableUnits;
  const total        = stats.totalUnits;
  if (total === 0) return;

  const availablePct = Math.round((available / total) * 100);

  if (availablePct <= REPLAN_THRESHOLDS.availableUnitsMinPercent) {
    // Only replan if there are active incidents worth rerouting
    const active = worldState.getActiveIncidents();
    if (active.length < 2) return; // need at least 2 active incidents to benefit from replan

    triggerReplan(
      `Resource saturation: ${available}/${total} units available (${availablePct}%)`,
      { availablePct }
    );
  }
}