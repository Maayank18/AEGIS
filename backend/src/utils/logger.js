// Structured logger — color-coded, timestamped, with agent context
const C = {
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  magenta:'\x1b[35m',
  blue:   '\x1b[34m',
  gray:   '\x1b[90m',
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
};

const AGENT_COLORS = {
  coordinator: C.cyan,
  police:      C.blue,
  fire:        C.red,
  ems:         C.green,
  traffic:     C.yellow,
  comms:       C.magenta,
  firewall:    C.red,
  system:      C.gray,
};

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function write(level, color, prefix, ...args) {
  const levelStr = level.padEnd(5);
  console.log(`${C.gray}[${ts()}]${C.reset} ${color}${C.bold}[${levelStr}]${C.reset} ${C.gray}${prefix}${C.reset}`, ...args);
}

export const logger = {
  info:    (...args) => write('INFO',  C.cyan,   'AEGIS', ...args),
  warn:    (...args) => write('WARN',  C.yellow, 'AEGIS', ...args),
  error:   (...args) => write('ERROR', C.red,    'AEGIS', ...args),
  success: (...args) => write('OK',    C.green,  'AEGIS', ...args),

  // Agent-specific logging — shows in the terminal which agent is reasoning
  agent: (agentName, ...args) => {
    const color = AGENT_COLORS[agentName] || C.gray;
    write('AGENT', color, `[${agentName.toUpperCase()}]`, ...args);
  },

  // Tool call logging — shows what tools the LLM is invoking
  tool: (toolName, args) => {
    write('TOOL',  C.magenta, `→ ${toolName}`, JSON.stringify(args));
  },

  // Token streaming log — lightweight, for debugging the stream pipe
  token: (chunk) => {
    process.stdout.write(`${C.gray}${chunk}${C.reset}`);
  },

  // Firewall events
  firewall: (level, ...args) => {
    const color = level === 'BLOCK' ? C.red : C.yellow;
    write('FIRE',  color, `[FIREWALL:${level}]`, ...args);
  },
};