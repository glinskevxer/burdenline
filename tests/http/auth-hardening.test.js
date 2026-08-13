/**
 * The authentication edges.
 *
 * Every one of these is a way somebody actually gets in or gets locked out: an
 * expired token, a token from another quarry, a role that was taken away this
 * morning, a header in the wrong shape. They are worth their own file because
 * they are the tests that stop being run when they live in among the ordinary
 * route tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp, testConfig } from './helpers.js';
import { issueToken, grantsFor } from '../../src/http/plugins/auth.js';
import { insertRow } from '../../src/db/repository.js';

let harness;

beforeEach(async () => {
  harness = await standUp({ at: '2026-05-05T09:00:00.000Z' });
});

afterEach(async () => {
  await harness.close();
});

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

describe('a token that is not usable', () => {
  it('refuses a request with no header at all', async () => {
    expect((await harness.get('/sites')).statusCode).toBe(401);
  });

  it('refuses a header that is not a bearer token', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/sites',
      headers: { authorization: 'Basic abcdef' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a bearer token that is not a token', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/sites',
      headers: bearer('not.a.token'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a token with the payload edited', async () => {
    const [header, payload, signature] = harness.tokens.viewer.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const tampered = Buffer.from(JSON.stringify({ ...decoded, roles: ['admin'] })).toString(
      'base64url',
    );
    const response = await harness.app.inject({
      method: 'GET',
      url: '/sites',
      headers: bearer(`${header}.${tampered}.${signature}`),
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses one that has expired', async () => {
    // The lifetime has to be set through the signer rather than by writing an
    // `exp` claim into the payload. The signer overwrites a claim it was also
    // given as an option, so a payload written that way comes back valid and the
    // test passes without ever having tested anything.
    const expired = harness.app.jwt.sign(
      { sub: 'per_viewer', name: 'viewer', roles: ['viewer'] },
      { expiresIn: '-60s' },
    );
    const claims = JSON.parse(Buffer.from(expired.split('.')[1], 'base64url').toString('utf8'));
    expect(claims.exp).toBeLessThan(Math.floor(Date.now() / 1000));
    const response = await harness.app.inject({
      method: 'GET',
      url: '/sites',
      headers: bearer(expired),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().detail).toContain('expired');
  });

  it('says nothing about the quarry in the refusal beyond the path asked for', async () => {
    const response = await harness.get('/sites');
    expect(response.json()).toMatchObject({ status: 401, detail: 'not authenticated' });
    expect(response.payload).not.toContain('Midway');
  });
});

describe('what a token carries', () => {
  it('does not let a token grant itself a role it was not signed with', async () => {
    const token = issueToken(harness.app, { id: 'per_viewer', name: 'viewer', roles: ['viewer'] });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/sites',
      headers: bearer(token),
      payload: { code: 'MDW', name: 'Midway' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('keeps working after the role is taken away, until the token runs out', async () => {
    const token = issueToken(harness.app, { id: 'per_admin', name: 'admin', roles: ['admin'] });
    harness.db.prepare("UPDATE person SET roles = 'viewer' WHERE id = 'per_admin'").run();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/sites',
      headers: bearer(token),
      payload: { code: 'MDW', name: 'Midway' },
    });
    expect(response.statusCode).toBe(201);
  });

  it('will not sign a new token for somebody who has been made inactive', async () => {
    insertRow(harness.db, 'person', {
      id: 'per_gone',
      name: 'Departed',
      roles: 'manager',
      active: 0,
      createdAt: '2026-05-05T09:00:00.000Z',
      updatedAt: '2026-05-05T09:00:00.000Z',
    });
    const response = await harness.post('/auth/token', undefined, { personId: 'per_gone' });
    expect(response.statusCode).toBe(401);
  });

  it('gives a person with no recognised role the reader grants only', async () => {
    insertRow(harness.db, 'person', {
      id: 'per_odd',
      name: 'Odd Job',
      roles: 'chief_taster',
      createdAt: '2026-05-05T09:00:00.000Z',
      updatedAt: '2026-05-05T09:00:00.000Z',
    });
    const issued = harness.expectOk(
      await harness.post('/auth/token', undefined, { personId: 'per_odd' }),
    );
    expect(issued.roles).toEqual([]);
    const who = harness.expectOk(
      await harness.app.inject({
        method: 'GET',
        url: '/auth/whoami',
        headers: bearer(issued.token),
      }),
    );
    expect(who.grants).toEqual(['read']);
  });
});

describe('what a role can reach', () => {
  const routes = [
    { method: 'POST', url: '/sites', payload: { code: 'ZZZ', name: 'Zed' }, allowed: ['admin'] },
    {
      method: 'GET',
      url: '/sites',
      allowed: ['admin', 'manager', 'designer', 'shotfirer', 'store', 'viewer'],
    },
  ];

  it('lets exactly the roles through that should get through', async () => {
    for (const route of routes) {
      for (const role of Object.keys(harness.tokens)) {
        const response = await harness.request(route.method, route.url, role, route.payload);
        const permitted = route.allowed.includes(role);
        expect([response.statusCode, role, route.url]).toEqual([
          permitted ? (route.method === 'POST' ? 201 : 200) : 403,
          role,
          route.url,
        ]);
        if (permitted && route.method === 'POST') {
          harness.db.prepare('DELETE FROM site WHERE code = ?').run('ZZZ');
        }
      }
    }
  });

  it('expands the roles into grants the same way everywhere', () => {
    expect(grantsFor(['admin'])).toContain('administer');
    expect(grantsFor(['viewer'])).not.toContain('administer');
  });

  it('signs tokens with the configured lifetime', async () => {
    const issued = harness.expectOk(
      await harness.post('/auth/token', undefined, { personId: 'per_manager' }),
    );
    expect(issued.expiresInMinutes).toBe(testConfig.auth.tokenTtlMinutes);
  });
});
