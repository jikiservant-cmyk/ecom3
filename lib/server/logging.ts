/**
 * Minimal structured JSON logger for server code.
 * Every log line is a single JSON object so log aggregators can parse it.
 * PII (emails, phone numbers) is masked by default in message strings.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

function maskPii(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email-redacted]')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[phone-redacted]');
}

function emit(level: Level, event: string, fields?: Record<string, unknown>) {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      line[k] = typeof v === 'string' ? maskPii(v) : v;
    }
  }
  const out = JSON.stringify(line);
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => emit('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields),
};

/**
 * Build a short, non-secret request id for correlating logs per request.
 */
export function newRequestId(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}
