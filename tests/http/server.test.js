import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../../src/http/server.js';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { loadConfig } from '../../src/config/env.js';
import { fixedClock } from '../../src/lib/clock.js';
import { createMemoryLogger } from '../../src/lib/logger.js';
import { normalise } from '../../src/http/plugins/errors.js';
import { NotFoundError, ValidationError, AppError } from '../../src/lib/errors.js';

let app;
let db;
let lines;

const config = loadConfig({ NODE_ENV: 'test', BURDENLINE_JWT_SECRET: 'a'.repeat(40) });

beforeEach(async () => {
  db = openDatabase({ database: { file: ':memory:' } });
  const memory = createMemoryLogger('info');
  lines = memory.lines;
  app = await buildServer({
    config,
    db,
    clock: fixedClock('2025-09-10T09:00:00Z'),
    logger: memory.logger,
  });
});

afterEach(async () => {
  await app.close();
  closeDatabase(db);
});

describe('health and readiness', () => {
  it('answers health without touching the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('answers ready when the database is open', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.json()).toEqual({ status: 'ready', database: 'ok' });
  });

  it('answers not ready when the database has gone', async () => {
    closeDatabase(db);
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().title).toBe('not ready');
  });

  it('describes itself without leaking the signing secret', async () => {
    const response = await app.inject({ method: 'GET', url: '/about' });
    expect(response.json().service).toBe('burdenline');
    expect(response.payload).not.toContain('aaaa');
  });
});

describe('errors', () => {
  it('renders a route that is not there as a problem document', async () => {
    const response = await app.inject({ method: 'GET', url: '/nowhere' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json().detail).toContain('/nowhere');
  });

  it('renders a domain error with its own status', async () => {
    app.get('/boom', async () => {
      throw new NotFoundError('hole', 'hole_4');
    });
    const response = await app.inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(404);
    expect(response.json().details).toEqual({ kind: 'hole', id: 'hole_4' });
  });

  it('renders a validation error with its issues', async () => {
    app.get('/bad', async () => {
      throw new ValidationError('no good', [
        { path: 'depth', message: 'too small', kind: 'range' },
      ]);
    });
    const response = await app.inject({ method: 'GET', url: '/bad' });
    expect(response.statusCode).toBe(422);
    expect(response.json().details.issues[0].path).toBe('depth');
  });

  it('hides the message of an error it does not own', async () => {
    app.get('/leak', async () => {
      throw new Error('connection string with a password in it');
    });
    const response = await app.inject({ method: 'GET', url: '/leak' });
    expect(response.statusCode).toBe(500);
    expect(response.payload).not.toContain('password');
  });

  it('puts the request id on every problem', async () => {
    const response = await app.inject({ method: 'GET', url: '/nowhere' });
    expect(response.json().requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs a server error at error level and a refusal at info', async () => {
    app.get('/leak2', async () => {
      throw new Error('boom');
    });
    app.get('/refuse', async () => {
      throw new AppError('nope', { status: 409, code: 'conflict' });
    });
    await app.inject({ method: 'GET', url: '/leak2' });
    await app.inject({ method: 'GET', url: '/refuse' });
    expect(lines.some((line) => line.level === 50 && line.msg === 'request failed')).toBe(true);
    expect(lines.some((line) => line.msg === 'request refused')).toBe(true);
  });
});

describe('normalise', () => {
  it('leaves a domain error alone', () => {
    const error = new NotFoundError('hole', 'h1');
    expect(normalise(error)).toBe(error);
  });

  it('turns a schema failure into a validation error', () => {
    const error = normalise({
      validation: [{ instancePath: '/burdenM', message: 'must be number', keyword: 'type' }],
    });
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.issues[0].path).toBe('burdenM');
  });

  it('names a missing property rather than leaving the path blank', () => {
    const error = normalise({
      validation: [
        { instancePath: '', message: 'is required', params: { missingProperty: 'reference' } },
      ],
    });
    expect(error.issues[0].path).toBe('reference');
  });

  it('turns an empty body into something a caller can read', () => {
    const error = normalise({ statusCode: 400, code: 'FST_ERR_CTP_EMPTY_JSON_BODY' });
    expect(error.message).toContain('body is empty');
  });
});

describe('logging', () => {
  it('logs one line per request with the status and how long it took', async () => {
    await app.inject({ method: 'GET', url: '/health' });
    const request = lines.find((line) => line.msg === 'request');
    expect(request.status).toBe(200);
    expect(request.url).toBe('/health');
    expect(typeof request.elapsedMs).toBe('number');
  });
});

describe('security headers', () => {
  it('sets the headers helmet is there for', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBeDefined();
  });
});
