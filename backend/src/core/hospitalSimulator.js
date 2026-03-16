/**
 * AEGIS Hospital Capacity Simulator
 * ─────────────────────────────────────────────────────────────────────────────
 * Simulates real-time hospital bed fluctuations so the system feels live.
 * Every 45 seconds, beds are admitted/discharged randomly within safe bounds.
 * When an EMS dispatch happens, we auto-decrement the target hospital.
 *
 * In a production system this would connect to NHM or hospital APIs.
 * For the hackathon, realistic simulation is the right call.
 */

import { worldState } from './worldState.js';
import { logger } from '../utils/logger.js';
import { broadcast } from '../utils/broadcast.js';

const FLUCTUATION_INTERVAL_MS = 45_000; // update every 45 seconds
const MIN_AVAILABLE_BEDS       = 2;     // never drop below this
const MIN_AVAILABLE_ICU        = 1;     // never drop below this ICU beds

export function startHospitalSimulator() {
  logger.success('🏥 Hospital capacity simulator started (45s fluctuation cycle)');
  setInterval(fluctuateHospitals, FLUCTUATION_INTERVAL_MS);
}

function fluctuateHospitals() {
  const hospitals = worldState.getAllHospitals();

  let updated = 0;
  for (const hospital of hospitals) {
    const bedDelta = randomDelta(hospital.availableBeds, hospital.totalBeds);
    const icuDelta = randomDelta(hospital.availableIcu, hospital.icuBeds, true);

    if (bedDelta === 0 && icuDelta === 0) continue;

    const newBeds = Math.max(MIN_AVAILABLE_BEDS, Math.min(hospital.totalBeds, hospital.availableBeds + bedDelta));
    const newIcu  = Math.max(MIN_AVAILABLE_ICU,  Math.min(hospital.icuBeds,   hospital.availableIcu  + icuDelta));

    // Only update if something actually changed
    if (newBeds !== hospital.availableBeds || newIcu !== hospital.availableIcu) {
      worldState.updateHospitalCapacity(hospital.id, newBeds, newIcu);
      updated++;
    }
  }

  if (updated > 0) {
    logger.info(`🏥 Hospital simulation: ${updated} hospitals updated`);
    // Broadcast aggregated summary for the frontend
    broadcast({
      type: 'HOSPITAL_SIMULATION_TICK',
      payload: {
        hospitals:    worldState.getAllHospitals().map(h => ({
          id:            h.id,
          name:          h.name,
          availableBeds: h.availableBeds,
          availableIcu:  h.availableIcu,
          status:        h.availableBeds <= 5 ? 'CRITICAL' : h.availableBeds <= 15 ? 'BUSY' : 'AVAILABLE',
        })),
        timestamp: new Date().toISOString(),
      },
    });
  }
}

// ─── Helper: calculate realistic bed delta ────────────────────────────────────
function randomDelta(current, total, isIcu = false) {
  const occupancyPct = 1 - (current / total);

  // Higher occupancy → more likely to admit, less likely to discharge
  // This simulates a real hospital where busy hospitals stay busy
  if (occupancyPct > 0.85) {
    // Very busy — small chance of freeing beds (discharges)
    return Math.random() < 0.3 ? (isIcu ? 1 : randInt(1, 2)) : 0;
  } else if (occupancyPct > 0.6) {
    // Moderately busy — fluctuate both ways
    const r = Math.random();
    if (r < 0.35) return isIcu ? -1 : -randInt(1, 2); // admit patients
    if (r < 0.65) return isIcu ?  1 : randInt(1, 2);  // discharge patients
    return 0;
  } else {
    // Low occupancy — more likely to admit
    const r = Math.random();
    if (r < 0.4) return isIcu ? -1 : -randInt(1, 3); // admit more
    if (r < 0.6) return isIcu ?  1 : randInt(1, 2);  // some discharges
    return 0;
  }
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}