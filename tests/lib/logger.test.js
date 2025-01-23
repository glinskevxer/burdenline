import { describe, it, expect } from 'vitest';
import {
  createLogger,
  createMemoryLogger,
  silentLogger,
  childFor,
  errorSerializer,
} from '../../src/lib/logger.js';
import { NotFoundError, RuleViolationError } from '../../src/lib/errors.js';

describe('createLogger', () => {
  it('takes its level from the config', () => {
    const logger = createLogger({ logging: { level: 'warn' }, env: 'test' });
    expect(logger.level).toBe('warn');
  });

  it('falls back to info when nothing is configured', () => {
    expect(createLogger({}).level).toBe('info');
  });

  it('stamps every line with the service and environment', () => {
    const { logger, lines } = createMemoryLogger();
    logger.info('loaded');
    expect(lines[0].service).toBe('burdenline');
    expect(lines[0].env).toBe('test');
    expect(lines[0].msg).toBe('loaded');
  });

  it('writes a timestamp a human can read', () => {
    const { logger, lines } = createMemoryLogger();
    logger.info('tick');
    expect(lines[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('redaction', () => {
  it('censors an authorization header', () => {
    const { logger, lines } = createMemoryLogger();
    logger.info({ req: { headers: { authorization: 'Bearer abc.def.ghi' } } }, 'request');
    expect(lines[0].req.headers.authorization).toBe('[redacted]');
    expect(JSON.stringify(lines[0])).not.toContain('abc.def.ghi');
  });

  it('censors a signing secret and a password wherever they sit', () => {
    const { logger, lines } = createMemoryLogger();
    logger.info({ auth: { jwtSecret: 'hunter2secret' }, user: { password: 'hunter2' } }, 'config');
    expect(lines[0].auth.jwtSecret).toBe('[redacted]');
    expect(lines[0].user.password).toBe('[redacted]');
  });
});

describe('error serialisation', () => {
  it('keeps the code, status and details of a known error', () => {
    const { logger, lines } = createMemoryLogger();
    logger.error({ err: new NotFoundError('hole', 'hole_1') }, 'lookup failed');
    expect(lines[0].err.code).toBe('not_found');
    expect(lines[0].err.status).toBe(404);
    expect(lines[0].err.details).toEqual({ kind: 'hole', id: 'hole_1' });
  });

  it('keeps the violations of a rule breach', () => {
    const serialised = errorSerializer(
      RuleViolationError.of([{ rule: 'stemming.min', message: 'too short' }]),
    );
    expect(serialised.details.violations[0].rule).toBe('stemming.min');
  });

  it('follows the cause chain', () => {
    const serialised = errorSerializer(new Error('outer', { cause: new Error('inner') }));
    expect(serialised.cause.message).toBe('inner');
  });

  it('passes a missing error straight through', () => {
    expect(errorSerializer(null)).toBe(null);
    expect(errorSerializer(undefined)).toBe(undefined);
  });
});

describe('children', () => {
  it('carries the bindings onto every line', () => {
    const { logger, lines } = createMemoryLogger();
    const child = childFor(logger, { requestId: 'req_1', shot: 'MDW-2025-004' });
    child.info('fired');
    expect(lines[0].requestId).toBe('req_1');
    expect(lines[0].shot).toBe('MDW-2025-004');
  });

  it('drops bindings that have no value', () => {
    const { logger, lines } = createMemoryLogger();
    childFor(logger, { requestId: 'req_2', operator: undefined, bench: null }).info('x');
    expect(lines[0]).not.toHaveProperty('operator');
    expect(lines[0]).not.toHaveProperty('bench');
  });

  it('takes an empty binding set', () => {
    const { logger } = createMemoryLogger();
    expect(() => childFor(logger, undefined).info('x')).not.toThrow();
  });
});

describe('silentLogger', () => {
  it('says nothing', () => {
    const logger = silentLogger();
    expect(logger.level).toBe('silent');
    expect(() => logger.error('boom')).not.toThrow();
  });
});
