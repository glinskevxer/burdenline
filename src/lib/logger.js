/**
 * Logging.
 *
 * One logger is built at startup and children are taken off it, so a request id
 * or a shot reference set once turns up on every line underneath. Redaction is
 * configured here rather than at the call sites, because the call site that
 * forgets is the one that logs the bearer token.
 */

import pino from 'pino';
import { isAppError } from './errors.js';

const REDACTED = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'password',
  '*.password',
  'jwtSecret',
  'auth.jwtSecret',
  'token',
  '*.token',
];

export function errorSerializer(error) {
  if (!error) {
    return error;
  }
  const base = {
    type: error.name,
    message: error.message,
    stack: error.stack,
  };
  if (isAppError(error)) {
    base.code = error.code;
    base.status = error.status;
    base.details = error.details;
  }
  if (error.cause) {
    base.cause = errorSerializer(error.cause);
  }
  return base;
}

export function createLogger(config, destination = undefined) {
  const options = {
    level: config?.logging?.level ?? 'info',
    base: { service: 'burdenline', env: config?.env ?? 'development' },
    redact: { paths: REDACTED, censor: '[redacted]' },
    serializers: { err: errorSerializer, error: errorSerializer },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(options, destination) : pino(options);
}

/** A logger that keeps its lines in an array, which is what the tests read. */
export function createMemoryLogger(level = 'trace') {
  const lines = [];
  const destination = {
    write(chunk) {
      lines.push(JSON.parse(chunk));
    },
  };
  const logger = createLogger({ logging: { level }, env: 'test' }, destination);
  return { logger, lines };
}

/** A logger that swallows everything, for the code paths a test is not reading. */
export function silentLogger() {
  return pino({ level: 'silent' });
}

export function childFor(logger, bindings) {
  const cleaned = Object.fromEntries(
    Object.entries(bindings ?? {}).filter(([, value]) => value !== undefined && value !== null),
  );
  return logger.child(cleaned);
}
