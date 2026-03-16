import { logger } from '../utils/logger.js';

// ─── Weather API Tool ─────────────────────────────────────────────────────────
// Mock weather data seeded with realistic Delhi summer conditions.
// Adds small random variance each call to simulate live sensor data.
// The fire spread risk calculation is what makes this strategically useful:
// the coordinator uses wind speed + direction to decide which way fire will spread
// and preemptively positions units in the downwind zone.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_WEATHER = {
  CP:  { windSpeed: 12, windDir: 'NW', temp: 34, humidity: 45, condition: 'clear',  visibility: 8 },
  RP:  { windSpeed: 10, windDir: 'N',  temp: 33, humidity: 47, condition: 'clear',  visibility: 9 },
  KB:  { windSpeed: 15, windDir: 'W',  temp: 35, humidity: 40, condition: 'hazy',   visibility: 6 },
  LN:  { windSpeed: 8,  windDir: 'SE', temp: 34, humidity: 50, condition: 'clear',  visibility: 8 },
  DW:  { windSpeed: 14, windDir: 'SW', temp: 36, humidity: 38, condition: 'clear',  visibility: 10},
  RH:  { windSpeed: 18, windDir: 'NW', temp: 33, humidity: 42, condition: 'dusty',  visibility: 5 },
  SD:  { windSpeed: 9,  windDir: 'E',  temp: 34, humidity: 52, condition: 'clear',  visibility: 7 },
  NP:  { windSpeed: 7,  windDir: 'S',  temp: 35, humidity: 48, condition: 'clear',  visibility: 8 },
  IGI: { windSpeed: 20, windDir: 'NW', temp: 35, humidity: 35, condition: 'clear',  visibility: 12},
  OKH: { windSpeed: 6,  windDir: 'SE', temp: 36, humidity: 50, condition: 'hazy',   visibility: 6 },
};

// Wind direction → fire spreads in the opposite direction
const SPREAD_OPPOSITE = {
  N: 'S', S: 'N', E: 'W', W: 'E',
  NW: 'SE', SE: 'NW', NE: 'SW', SW: 'NE',
};

// Which zone is downwind from a given zone for a given wind direction
const DOWNWIND_ZONES = {
  CP_NW: 'SD', CP_N: 'RP', CP_SE: 'KB', CP_S: 'LN',
  SD_E: 'CP', SD_N: 'RH', KB_W: 'DW', RH_NW: 'SD',
};

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Tool: getWeather
 * Returns live weather conditions for a zone including fire spread risk.
 */
export async function getWeather({ zone }) {
  logger.tool('getWeather', { zone });

  const base = BASE_WEATHER[zone] || BASE_WEATHER['CP'];

  const windSpeed = Math.max(0, base.windSpeed + rand(-2, 4));
  const temp      = base.temp      + rand(-1, 2);
  const humidity  = base.humidity  + rand(-3, 3);

  // Fire spread risk calculation
  let fireSpreadRisk;
  let fireSpreadRiskScore;
  if (windSpeed >= 20) {
    fireSpreadRisk      = 'EXTREME';
    fireSpreadRiskScore = 10;
  } else if (windSpeed >= 15) {
    fireSpreadRisk      = 'HIGH';
    fireSpreadRiskScore = 7;
  } else if (windSpeed >= 10) {
    fireSpreadRisk      = 'MEDIUM';
    fireSpreadRiskScore = 4;
  } else {
    fireSpreadRisk      = 'LOW';
    fireSpreadRiskScore = 2;
  }

  // Humidity adjustment (dry = higher risk)
  if (humidity < 30) fireSpreadRiskScore = Math.min(10, fireSpreadRiskScore + 2);

  const spreadDirection = SPREAD_OPPOSITE[base.windDir] || 'variable';
  const downwindZone    = DOWNWIND_ZONES[`${zone}_${base.windDir}`] || null;

  return {
    success: true,
    weather: {
      zone,
      windSpeed,
      windDirection:    base.windDir,
      temperature:      temp,
      humidity,
      condition:        base.condition,
      visibilityKm:     base.visibility,
      fireSpreadRisk,
      fireSpreadRiskScore,
      fireSpreadDirection: spreadDirection,
      downwindZone,
      timestamp:        new Date().toISOString(),
      advisory: windSpeed > 15
        ? `High wind advisory: Fire spread risk is ${fireSpreadRisk}. Pre-position units in ${downwindZone || 'adjacent zones'} to the ${spreadDirection}.`
        : null,
    },
  };
}

// ─── Groq Function Schema ─────────────────────────────────────────────────────

export const getWeatherSchema = {
  type: 'function',
  function: {
    name: 'getWeather',
    description:
      'Get current weather conditions for a Delhi zone. ' +
      'Critical for fire incidents — returns wind speed, direction, fire spread risk rating (LOW/MEDIUM/HIGH/EXTREME), ' +
      'and which zone is downwind (where fire will spread next). ' +
      'Use this immediately when a fire incident is reported.',
    parameters: {
      type: 'object',
      properties: {
        zone: {
          type: 'string',
          description: 'Zone ID to get weather conditions for.',
          enum: ['CP', 'RP', 'KB', 'LN', 'DW', 'RH', 'SD', 'NP', 'IGI', 'OKH'],
        },
      },
      required: ['zone'],
    },
  },
};