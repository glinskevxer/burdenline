import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../../src/http/server.js';
import {
  registerAuth,
  authRoutes,
  issueToken,
  grantsFor,
  GRANTS,
  ROLES,
} from '../../src/http/plugins/auth.js';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { insertRow } from '../../src/db/repository.js';
import { loadConfig } from '../../src/config/env.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';

let app;
let db;
const clock = fixedClock('2025-09-15T09:00:00Z');
const config = loadConfig({ NODE_ENV: 'test', BURDENLINE_JWT_SECRET: 'b'.repeat(40) });

function person(id, name, roles, active = 1) {
  insertRow(db, 'person', {
    id,
    name,
    roles,
    active,
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
}

beforeEach(async () => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations]);
  app = await buildServer({ config, db, clock, logger: silentLogger() });
  await registerAuth(app, { config });
  authRoutes(app);
  app.get('/design-only', { preHandler: app.requireGrant('design') }, async () => ({ ok: true }));
  app.get('/administer-only', { preHandler: app.requireGrant('administer') }, async () => ({
    ok: true,
  }));
  person('per_1', 'M Cronin', 'shotfirer');
  person('per_2', 'J Ryan', 'manager');
  person('per_3', 'Old Hand', 'manager', 0);
});

afterEach(async () => {
  await app.close();
  closeDatabase(db);
});

async function tokenFor(personId, siteId) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/token',
    payload: { personId, ...(siteId ? { siteId } : {}) },
  });
  return response.json().token;
}

describe('grants', () => {
  it('expands a role into what it may do', () => {
    expect(grantsFor(['viewer'])).toEqual(['read']);
    expect(grantsFor(['shotfirer'])).toContain('fire');
  });

  it('takes the union of several roles', () => {
    const grants = grantsFor(['store', 'shotfirer']);
    expect(grants).toContain('magazine');
    expect(grants).toContain('fire');
  });

  it('reads an unknown role as nothing at all', () => {
    expect(grantsFor(['pilot'])).toEqual([]);
    expect(grantsFor()).toEqual([]);
  });

  it('gives every named role a grant list', () => {
    for (const role of ROLES) {
      expect(GRANTS[role].length).toBeGreaterThan(0);
    }
  });

  it('gives only the administrator the administer grant', () => {
    const withAdminister = ROLES.filter((role) => GRANTS[role].includes('administer'));
    expect(withAdminister).toEqual(['admin']);
  });
});

describe('issuing a token', () => {
  it('signs one for a person on file', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { personId: 'per_1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().roles).toEqual(['shotfirer']);
    expect(typeof response.json().token).toBe('string');
  });

  it('refuses somebody who has left', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { personId: 'per_3' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses somebody who is not on file', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { personId: 'per_9' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a request with no person in it', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/token', payload: {} });
    expect(response.statusCode).toBe(422);
  });

  it('refuses to sign a role nobody has defined', () => {
    expect(() => issueToken(app, { id: 'per_1', name: 'x', roles: ['pilot'] })).toThrow(
      /unknown role/,
    );
  });
});

describe('whoami', () => {
  it('reads the actor back off the token', async () => {
    const token = await tokenFor('per_2', 'site_1');
    const response = await app.inject({
      method: 'GET',
      url: '/auth/whoami',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.json()).toMatchObject({ id: 'per_2', name: 'J Ryan', siteId: 'site_1' });
    expect(response.json().grants).toContain('approve');
  });

  it('refuses a request with no token', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/whoami' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a token signed with another secret', async () => {
    const other = await buildServer({
      config: loadConfig({ NODE_ENV: 'test', BURDENLINE_JWT_SECRET: 'c'.repeat(40) }),
      db,
      clock,
      logger: silentLogger(),
    });
    await registerAuth(other, {
      config: loadConfig({ NODE_ENV: 'test', BURDENLINE_JWT_SECRET: 'c'.repeat(40) }),
    });
    const foreign = issueToken(other, { id: 'per_2', name: 'J Ryan', roles: ['manager'] });
    const response = await app.inject({
      method: 'GET',
      url: '/auth/whoami',
      headers: { authorization: `Bearer ${foreign}` },
    });
    expect(response.statusCode).toBe(401);
    await other.close();
  });
});

describe('grants on a route', () => {
  it('lets a manager through a route that needs design', async () => {
    const token = await tokenFor('per_2');
    const response = await app.inject({
      method: 'GET',
      url: '/design-only',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('keeps a shotfirer out of it', async () => {
    const token = await tokenFor('per_1');
    const response = await app.inject({
      method: 'GET',
      url: '/design-only',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().details.needed).toBe('design');
  });

  it('keeps even a manager out of an administrator route', async () => {
    const token = await tokenFor('per_2');
    const response = await app.inject({
      method: 'GET',
      url: '/administer-only',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it('answers unauthenticated before unauthorised', async () => {
    const response = await app.inject({ method: 'GET', url: '/design-only' });
    expect(response.statusCode).toBe(401);
  });
});

describe('site scoping', () => {
  it('lets a token through for its own site', async () => {
    app.get('/sites/:siteId/thing', {
      preHandler: app.requireSite((request) => request.params.siteId),
      handler: async () => ({ ok: true }),
    });
    const token = await tokenFor('per_2', 'site_1');
    const response = await app.inject({
      method: 'GET',
      url: '/sites/site_1/thing',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses it for another site', async () => {
    app.get('/sites/:siteId/thing', {
      preHandler: app.requireSite((request) => request.params.siteId),
      handler: async () => ({ ok: true }),
    });
    const token = await tokenFor('per_2', 'site_1');
    const response = await app.inject({
      method: 'GET',
      url: '/sites/site_2/thing',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
  });
});
