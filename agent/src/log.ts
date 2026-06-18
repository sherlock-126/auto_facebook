/**
 * Tiny structured JSON logger to stdout — captured by journalctl on customer VPS.
 */
type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), level, msg, ...(extra ?? {}) };
  process.stdout.write(JSON.stringify(line) + '\n');
}
