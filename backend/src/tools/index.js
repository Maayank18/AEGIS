import { getRoute,            getRouteSchema,            blockRoad,               blockRoadSchema          } from './routing.js';
import { getAvailableUnits,   getAvailableUnitsSchema,   dispatchUnit,            dispatchUnitSchema,
         returnUnit,          returnUnitSchema,          notifyCitizens,          notifyCitizensSchema     } from './resourceTracker.js';
import { getHospitalCapacity, getHospitalCapacitySchema, updateHospitalCapacity,  updateHospitalCapacitySchema } from './hospitalApi.js';
import { getWeather,          getWeatherSchema                                                             } from './weatherApi.js';
import { logger } from '../utils/logger.js';

const TOOL_EXECUTORS = {
  getRoute,
  blockRoad,
  getAvailableUnits,
  dispatchUnit,
  returnUnit,
  notifyCitizens,
  getHospitalCapacity,
  updateHospitalCapacity,
  getWeather,
};

export const ALL_TOOLS_SCHEMAS = [
  getRouteSchema,
  blockRoadSchema,
  getAvailableUnitsSchema,
  dispatchUnitSchema,
  returnUnitSchema,
  notifyCitizensSchema,
  getHospitalCapacitySchema,
  updateHospitalCapacitySchema,
  getWeatherSchema,
];

export const POLICE_TOOLS  = [getAvailableUnitsSchema, dispatchUnitSchema, returnUnitSchema, getRouteSchema, notifyCitizensSchema];
export const FIRE_TOOLS    = [getAvailableUnitsSchema, dispatchUnitSchema, returnUnitSchema, getRouteSchema, getWeatherSchema, notifyCitizensSchema];
export const EMS_TOOLS     = [getAvailableUnitsSchema, dispatchUnitSchema, returnUnitSchema, getRouteSchema, getHospitalCapacitySchema, updateHospitalCapacitySchema];
export const TRAFFIC_TOOLS = [blockRoadSchema, getRouteSchema, notifyCitizensSchema, getAvailableUnitsSchema, dispatchUnitSchema];
export const COMMS_TOOLS   = [notifyCitizensSchema];

export async function executeTool(name, argsString) {
  const executor = TOOL_EXECUTORS[name];

  if (!executor) {
    logger.warn(`Unknown tool called by LLM: "${name}"`);
    return {
      name,
      parsedArgs: {},
      result: {
        success: false,
        error: `Tool '${name}' is not registered. Available tools: ${Object.keys(TOOL_EXECUTORS).join(', ')}`,
      },
    };
  }

  let parsedArgs;
  try {
    parsedArgs = typeof argsString === 'string' ? JSON.parse(argsString) : argsString;
  } catch {
    parsedArgs = {};
    logger.warn(`Failed to parse args for tool ${name}: ${argsString}`);
  }

  try {
    const result = await executor(parsedArgs);
    return { name, parsedArgs, result };
  } catch (err) {
    logger.error(`Tool ${name} threw:`, err.message);
    return {
      name,
      parsedArgs,
      result: { success: false, error: `Tool execution failed: ${err.message}` },
    };
  }
}