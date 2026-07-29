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

  it('answers not ready on a database that has had no migrations', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().database).toBe('ok');
  });

  it('answers not ready when the database has gone', async () => {
    closeDatabase(db);
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().title).toBe('not ready');
    expect(response.json().database).toBe('unavailable');
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

describe('the framework own refusals', () => {
  it('keeps the status of a body that is too large', () => {
    const error = normalise({ statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
    expect(error.status).toBe(413);
    expect(error.code).toBe('body_too_large');
    expect(error.message).toContain('larger than this route accepts');
  });

  it('keeps the status of json that does not parse', () => {
    const error = normalise({ statusCode: 400, code: 'FST_ERR_CTP_INVALID_JSON_BODY' });
    expect(error.status).toBe(400);
    expect(error.code).toBe('malformed_json');
  });

  it('keeps the status of a content type nobody serves', () => {
    expect(normalise({ statusCode: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' }).status).toBe(415);
  });

  it('gives an unrecognised client error a plain message rather than its own', () => {
    const error = normalise({
      statusCode: 428,
      code: 'FST_SOMETHING',
      message: 'internal detail here',
    });
    expect(error.status).toBe(428);
    expect(error.message).not.toContain('internal detail');
  });

  it('leaves a server side error alone so it renders as a five hundred', () => {
    const error = new Error('the disk filled up');
    error.statusCode = 503;
    expect(normalise(error)).toBe(error);
  });
});

describe('GET /about', () => {
  it('says what build this is and what schema it expects', async () => {
    const response = await app.inject({ method: 'GET', url: '/about' });
    const body = response.json();
    expect(body.service).toBe('burdenline');
    expect(body.node).toBe(process.version);
    expect(body.startedAt).toBe('2025-09-10T09:00:00.000Z');
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('counts what is in the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/about' });
    expect(response.json().counts).toHaveProperty('site');
    expect(response.json().counts).toHaveProperty('blast');
  });

  it('answers even when the database has nothing in it to count', async () => {
    const response = await app.inject({ method: 'GET', url: '/about' });
    expect(response.statusCode).toBe(200);
    expect(response.json().schemaVersion).toBe(null);
  });

  it('answers rather than falling over when the database has gone', async () => {
    closeDatabase(db);
    const response = await app.inject({ method: 'GET', url: '/about' });
    expect(response.statusCode).toBe(200);
    expect(response.json().counts.site).toBe(null);
  });

  it('still says nothing about the signing secret', async () => {
    const response = await app.inject({ method: 'GET', url: '/about' });
    expect(response.payload).not.toContain('aaaa');
  });
});

describe('readiness against the schema', () => {
  it('is not ready on a database with no migrations applied', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().detail).toContain('migrations have not been applied');
    expect(response.json().pendingMigrations).toBeGreaterThan(0);
  });

  it('is ready once the database is at the schema this build expects', async () => {
    const migrated = openDatabase({ database: { file: ':memory:' } });
    const { runMigrations, loadMigrations } = await import('../../src/db/migrate.js');
    runMigrations(migrated, await loadMigrations());
    const ready = await buildServer({
      config,
      db: migrated,
      clock: fixedClock('2025-09-10T09:00:00Z'),
    });
    const response = await ready.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ready', pendingMigrations: 0 });
    await ready.close();
    closeDatabase(migrated);
  });

  it('says the database is unavailable rather than guessing when it has gone', async () => {
    closeDatabase(db);
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().detail).toContain('not answering');
  });
});
