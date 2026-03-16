// import Groq from 'groq-sdk';
// import dotenv from 'dotenv';
// import { fileURLToPath } from 'url';
// import { dirname, join } from 'path';

// const __dirname = dirname(fileURLToPath(import.meta.url));
// dotenv.config({ path: join(__dirname, '../../.env') });

// export const groq = new Groq({
//   apiKey: process.env.GROQ_API_KEY,
// });

// export const MODEL = 'llama-3.3-70b-versatile';

// export const PORT     = parseInt(process.env.PORT     || '8000', 10);
// export const WS_PORT  = parseInt(process.env.WS_PORT  || '8001', 10);

// export const MONGO_URI    = process.env.MONGO_URI    || 'mongodb://localhost:27017/aegis';
// export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// export const REPLAN_THRESHOLDS = {
//   availableUnitsMinPercent: 30,
//   criticalIncidentPriority: 8,
//   bridgeCollapse: true,
// };

// export const FIREWALL_CONFIG = {
//   llmScoreThreshold: 7.0,
//   regexPatterns: [
//     /ignore\s+(all\s+)?previous\s+instructions/i,
//     /disregard\s+(your\s+)?(system\s+)?prompt/i,
//     /you\s+are\s+now\s+a/i,
//     /act\s+as\s+(a\s+)?different/i,
//     /override\s+(safety|security|protocol)/i,
//     /send\s+all\s+(units|police|fire|ems)\s+to\s+headquarters/i,
//     /forget\s+(everything|all|your\s+instructions)/i,
//     /new\s+instructions?\s*:/i,
//     /system\s*:\s*(you|act|ignore)/i,
//     /\[\s*INST\s*\]/i,
//     /<\s*\/?SYS\s*>/i,
//   ],
// };







import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Try multiple locations — works regardless of where node is invoked from
dotenv.config({ path: join(__dirname, '../../.env') }); // AEGIS/.env
dotenv.config({ path: join(__dirname, '../.env') });    // AEGIS/backend/src/.env
dotenv.config({ path: join(process.cwd(), '.env') });  // wherever node runs from

export const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export const MODEL = 'llama-3.3-70b-versatile';

export const PORT     = parseInt(process.env.PORT     || '8000', 10);
export const WS_PORT  = parseInt(process.env.WS_PORT  || '8001', 10);

export const MONGO_URI    = process.env.MONGO_URI    || 'mongodb://localhost:27017/aegis';
export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

export const REPLAN_THRESHOLDS = {
  availableUnitsMinPercent: 30,
  criticalIncidentPriority: 8,
  bridgeCollapse: true,
};

export const FIREWALL_CONFIG = {
  llmScoreThreshold: 7.0,
  regexPatterns: [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /disregard\s+(your\s+)?(system\s+)?prompt/i,
    /you\s+are\s+now\s+a/i,
    /act\s+as\s+(a\s+)?different/i,
    /override\s+(safety|security|protocol)/i,
    /send\s+all\s+(units|police|fire|ems)\s+to\s+headquarters/i,
    /forget\s+(everything|all|your\s+instructions)/i,
    /new\s+instructions?\s*:/i,
    /system\s*:\s*(you|act|ignore)/i,
    /\[\s*INST\s*\]/i,
    /<\s*\/?SYS\s*>/i,
  ],
};