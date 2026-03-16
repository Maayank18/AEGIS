import { worldState } from '../core/worldState.js';
import { logger } from '../utils/logger.js';

// ─── Hospital API Tool ────────────────────────────────────────────────────────
// Real-time hospital bed and ICU availability.
// EMS agent calls this before routing casualties to determine optimal destination.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool: getHospitalCapacity
 * Returns bed availability for all hospitals, optionally filtered by zone.
 * Sorts results by available beds descending so the LLM sees the best option first.
 */
export async function getHospitalCapacity({ zone = null } = {}) {
  logger.tool('getHospitalCapacity', { zone });

  const all      = worldState.getAllHospitals();
  const filtered = zone ? all.filter(h => h.zone === zone) : all;

  const hospitals = filtered
    .sort((a, b) => b.availableBeds - a.availableBeds)
    .map(h => ({
      id:              h.id,
      name:            h.name,
      zone:            h.zone,
      level:           h.level,
      availableBeds:   h.availableBeds,
      totalBeds:       h.totalBeds,
      availableIcu:    h.availableIcu,
      totalIcu:        h.icuBeds,
      specialties:     h.specialties,
      occupancyPct:    Math.round(((h.totalBeds - h.availableBeds) / h.totalBeds) * 100),
      icuOccupancyPct: Math.round(((h.icuBeds - h.availableIcu) / h.icuBeds) * 100),
      status:          h.availableBeds === 0 ? 'FULL' : h.availableBeds < 5 ? 'NEAR_CAPACITY' : 'AVAILABLE',
    }));

  const best = hospitals[0];

  return {
    success: true,
    totalQueried: hospitals.length,
    hospitals,
    recommendation: best
      ? `Best option: ${best.name} (${best.availableBeds} beds, ${best.availableIcu} ICU available)`
      : 'All hospitals at capacity — consider mutual aid request',
    totalAvailableBeds: hospitals.reduce((s, h) => s + h.availableBeds, 0),
    totalAvailableIcu:  hospitals.reduce((s, h) => s + h.availableIcu, 0),
  };
}

/**
 * Tool: updateHospitalCapacity
 * Decrement bed count after routing casualties to a hospital.
 * Call this after EMS delivers patients so capacity stays accurate.
 */
export async function updateHospitalCapacity({ hospitalId, availableBeds, availableIcu }) {
  logger.tool('updateHospitalCapacity', { hospitalId, availableBeds, availableIcu });

  try {
    const hospital = worldState.updateHospitalCapacity(hospitalId, availableBeds, availableIcu ?? null);
    return {
      success: true,
      hospital: {
        id:            hospital.id,
        name:          hospital.name,
        availableBeds: hospital.availableBeds,
        availableIcu:  hospital.availableIcu,
      },
      message: `${hospital.name} capacity updated: ${hospital.availableBeds} beds, ${hospital.availableIcu} ICU available.`,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Groq Function Schemas ────────────────────────────────────────────────────

export const getHospitalCapacitySchema = {
  type: 'function',
  function: {
    name: 'getHospitalCapacity',
    description:
      'Get real-time hospital bed and ICU availability across Delhi. ' +
      'Use before routing casualties — results are sorted by most available beds first. ' +
      'Critical for mass casualty events where multiple hospitals may be needed.',
    parameters: {
      type: 'object',
      properties: {
        zone: {
          type: 'string',
          description: 'Optional: filter hospitals near a specific zone. Omit for all Delhi hospitals.',
          enum: ['CP', 'RP', 'KB', 'LN', 'DW', 'RH', 'SD', 'NP', 'IGI', 'OKH'],
        },
      },
      required: [],
    },
  },
};

export const updateHospitalCapacitySchema = {
  type: 'function',
  function: {
    name: 'updateHospitalCapacity',
    description:
      'Update a hospital bed count after patient intake. ' +
      'Call this after EMS delivers casualties to keep capacity tracking accurate for subsequent decisions.',
    parameters: {
      type: 'object',
      properties: {
        hospitalId: {
          type: 'string',
          description: 'Hospital ID (e.g. "H-1" for AIIMS, "H-2" for Safdarjung)',
          enum: ['H-1', 'H-2', 'H-3', 'H-4', 'H-5'],
        },
        availableBeds: {
          type: 'number',
          description: 'New available general bed count after patient intake.',
        },
        availableIcu: {
          type: 'number',
          description: 'New available ICU bed count. Omit if ICU count unchanged.',
        },
      },
      required: ['hospitalId', 'availableBeds'],
    },
  },
};