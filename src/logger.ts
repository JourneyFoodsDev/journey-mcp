type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEYS = /(key|token|secret|authorization|password|cookie)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** JSON lines to stderr (stdout is reserved for the stdio MCP transport). Secret-looking fields are redacted. */
export function createLogger(level: Level = (process.env.LOG_LEVEL as Level) || 'info', sink: (line: string) => void = (line) => { process.stderr.write(line + '\n'); }): Logger {
  const min = ORDER[level] ?? ORDER.info;
  const emit = (l: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[l] < min) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level: l, msg, ...(redact(fields ?? {}) as object) }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
