/** Contexture-owned logging that never writes to the stdio protocol stream. */

export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error'] as const);
export type LogLevel = (typeof LOG_LEVELS)[number];

const ranks: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

let threshold = ranks.info;

/** Return whether a value is a supported Contexture logging level. */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(ranks, value);
}

/**
 * Configure Contexture's process-wide logger to write exclusively to stderr.
 *
 * Node has no process-wide logging registry comparable to Python's `logging`
 * root logger. Contexture therefore owns this small logger explicitly instead
 * of patching `console`, while still preserving stdout for MCP stdio framing.
 */
export function configureLogging(level: LogLevel = 'info'): void {
  if (!isLogLevel(level))
    throw new TypeError(`Unknown Contexture log level ${JSON.stringify(level)}.`);
  threshold = ranks[level];
}

/** Emit one Contexture lifecycle record to stderr when it passes the configured level. */
export function log(level: LogLevel, message: string): void {
  if (ranks[level] < threshold) return;
  process.stderr.write(
    `${new Date().toISOString()} ${level.toUpperCase()} contexture: ${message}\n`,
  );
}
