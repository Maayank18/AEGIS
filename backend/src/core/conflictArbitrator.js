import { worldState } from './worldState.js';
import { logger } from '../utils/logger.js';
import { broadcast } from '../utils/broadcast.js';
import { AuditEntry } from '../models/AuditEntry.js';

// ─── Conflict Arbitrator ──────────────────────────────────────────────────────
// When two sub-agents want the same unit simultaneously, this module
// runs a utility score calculation and awards the unit with written justification.
// The decision + scoring is logged to AuditTimeline — a key judge demo moment.
// ─────────────────────────────────────────────────────────────────────────────

// Priority weights for different incident types
const INCIDENT_PRIORITY_WEIGHTS = {
  mass_casualty:        10,
  bridge_collapse:       9,
  structural_fire:       8,
  building_collapse:     8,
  power_outage:          7,
  hazmat:                7,
  vehicle_accident:      6,
  robbery:               5,
  general_incident:      4,
};

/**
 * Resolve contention when two agents request the same unit.
 *
 * @param {object} request1 - { agentType, incidentId, incidentType, zone, urgency }
 * @param {object} request2 - { agentType, incidentId, incidentType, zone, urgency }
 * @param {string} unitId   - The contested unit
 * @returns {{ winner, loser, unitId, score1, score2, justification }}
 */
export function arbitrate(request1, request2, unitId) {
  const unit = worldState.getUnit(unitId);
  if (!unit) {
    throw new Error(`Cannot arbitrate — unit ${unitId} not found`);
  }

  const score1 = calculateUtilityScore(request1, unit);
  const score2 = calculateUtilityScore(request2, unit);

  const winner = score1 >= score2 ? request1 : request2;
  const loser  = score1 >= score2 ? request2 : request1;
  const winnerScore = Math.max(score1, score2);
  const loserScore  = Math.min(score1, score2);

  const justification = buildJustification(winner, loser, unit, winnerScore, loserScore);

  logger.agent('coordinator', `⚖️  Conflict resolved: ${unit.name} awarded to ${winner.agentType} agent`);
  logger.agent('coordinator', `   ${winner.agentType}: ${winnerScore.toFixed(1)} pts vs ${loser.agentType}: ${loserScore.toFixed(1)} pts`);

  const decision = {
    unitId,
    unitName:      unit.name,
    winner:        winner.agentType,
    loser:         loser.agentType,
    winnerIncidentId: winner.incidentId,
    loserIncidentId:  loser.incidentId,
    winnerScore:   winnerScore.toFixed(1),
    loserScore:    loserScore.toFixed(1),
    justification,
    timestamp:     new Date().toISOString(),
  };

  // Broadcast to AuditTimeline — judges see this
  broadcast({
    type: 'CONFLICT_RESOLVED',
    payload: decision,
  });

  // Persist to MongoDB
  AuditEntry.create({
    incidentId:   winner.incidentId,
    agentType:    'coordinator',
    eventType:    'conflict_arbitration',
    zone:         winner.zone,
    priority:     winner.urgency,
    reasoning:    justification,
    decision:     `Unit ${unitId} (${unit.name}) awarded to ${winner.agentType} agent`,
    metadata:     { score1, score2, loserIncidentId: loser.incidentId },
  }).catch(err => logger.error('Arbitration audit log failed:', err.message));

  return decision;
}

function calculateUtilityScore(request, unit) {
  let score = 0;

  // Base score from incident priority (0–10)
  score += (request.urgency || 5) * 2;

  // Incident type weight
  const typeWeight = INCIDENT_PRIORITY_WEIGHTS[request.incidentType] || 4;
  score += typeWeight;

  // Specialty match bonus — matching specialist to incident type
  const specialtyBonus = getSpecialtyBonus(unit, request);
  score += specialtyBonus;

  // Proximity bonus — closer unit = higher score
  const proximityBonus = unit.currentZone === request.zone ? 5 : 0;
  score += proximityBonus;

  // Life-threat multiplier for medical/casualty events
  const lifeThreat = ['mass_casualty', 'building_collapse', 'structural_fire'].includes(request.incidentType);
  if (lifeThreat) score *= 1.3;

  return Math.round(score * 10) / 10;
}

function getSpecialtyBonus(unit, request) {
  const bonusMap = {
    mass_casualty:   { ems: 5, fire: 3 },
    structural_fire: { fire: 5, ems: 2 },
    hazmat:          { fire: 5 },
    robbery:         { police: 5 },
    bridge_collapse: { traffic: 5, fire: 3 },
    power_outage:    { traffic: 4 },
  };
  const map     = bonusMap[request.incidentType] || {};
  return map[unit.type] || 0;
}

function buildJustification(winner, loser, unit, winnerScore, loserScore) {
  const margin = (winnerScore - loserScore).toFixed(1);
  return (
    `CONFLICT ARBITRATION RESULT\n` +
    `Unit contested: ${unit.name} (${unit.id}) — ${unit.type.toUpperCase()} unit in zone ${unit.currentZone}\n\n` +
    `Competing requests:\n` +
    `  • ${winner.agentType.toUpperCase()} Agent — incident ${winner.incidentId} (${winner.incidentType}, priority ${winner.urgency}/10, zone ${winner.zone})\n` +
    `    Utility score: ${winnerScore} pts\n` +
    `  • ${loser.agentType.toUpperCase()} Agent — incident ${loser.incidentId} (${loser.incidentType}, priority ${loser.urgency}/10, zone ${loser.zone})\n` +
    `    Utility score: ${loserScore} pts\n\n` +
    `Decision: ${unit.name} AWARDED to ${winner.agentType.toUpperCase()} Agent (margin: +${margin} pts)\n` +
    `Factors: incident urgency × 2 + type weight + specialty match bonus + proximity bonus + life-threat multiplier.\n` +
    `${loser.agentType.toUpperCase()} agent must source an alternative unit or request mutual aid.`
  );
}