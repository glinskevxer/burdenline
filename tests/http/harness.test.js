import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';

let harness;

beforeEach(async () => {
  harness = await standUp();
});

afterEach(async () => {
  await harness.close();
});

describe('the http harness', () => {
  it('signs a token for every role', () => {
    expect(Object.keys(harness.tokens).sort()).toEqual([
      'admin',
      'designer',
      'manager',
      'shotfirer',
      'store',
      'viewer',
    ]);
  });

  it('sends no body when none is given, so a plain button press is not a 422', async () => {
    const site = harness.expectOk(
      await harness.post('/sites', 'admin', { code: 'MDW', name: 'Midway' }),
      201,
    );
    const bench = harness.expectOk(
      await harness.post(`/sites/${site.site.id}/benches`, 'designer', {
        name: 'North 60',
        crestLevelM: 84,
        toeLevelM: 69,
        rockType: 'dolerite',
        rockDensityKgM3: 2900,
      }),
      201,
    );
    const retired = await harness.post(`/benches/${bench.bench.id}/retire`, 'designer');
    expect(retired.statusCode).toBe(200);
  });

  it('sends a body when one is given', async () => {
    const response = await harness.post('/sites', 'admin', { code: 'RCK', name: 'Rockfield' });
    expect(response.statusCode).toBe(201);
  });

  it('sends no token when no role is named', async () => {
    expect((await harness.get('/sites')).statusCode).toBe(401);
  });

  it('takes extra headers alongside the token', async () => {
    const response = await harness.post(
      '/sites',
      'admin',
      { code: 'ABC', name: 'Another' },
      { 'idempotency-key': 'harness-1' },
    );
    expect(response.statusCode).toBe(201);
    const again = await harness.post(
      '/sites',
      'admin',
      { code: 'ABC', name: 'Another' },
      { 'idempotency-key': 'harness-1' },
    );
    expect(again.headers['idempotent-replay']).toBe('true');
  });

  it('does the other verbs too', async () => {
    const site = harness.expectOk(
      await harness.post('/sites', 'admin', { code: 'MDW', name: 'Midway' }),
      201,
    ).site;
    expect(
      (await harness.patch(`/sites/${site.id}`, 'admin', { name: 'Midway Quarry' })).statusCode,
    ).toBe(200);
    expect((await harness.del(`/sites/${site.id}/rules/charge`, 'admin')).statusCode).toBe(404);
  });

  it('reads a failure clearly rather than throwing on json', async () => {
    const response = await harness.post('/sites', 'admin', { code: 'lowercase', name: 'x' });
    expect(() => harness.expectOk(response, 201)).toThrow(/expected 201, got 422/);
  });
});
