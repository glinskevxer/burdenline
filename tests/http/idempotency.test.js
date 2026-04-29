import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';
import { createStore, fingerprint, idempotencyHeader } from '../../src/http/plugins/idempotency.js';

let harness;
let siteId;
let magazineId;
let batchId;

async function post(url, role, payload, headers = {}) {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: { ...harness.as(role), ...headers },
    payload,
  });
}

beforeEach(async () => {
  harness = await standUp({ at: '2026-04-14T09:00:00.000Z' });
  siteId = (await post('/sites', 'admin', { code: 'MDW', name: 'Midway' })).json().site.id;
  const product = (
    await post('/products', 'admin', {
      code: 'ANFO-80',
      name: 'Ammonium nitrate fuel oil',
      kind: 'bulk_anfo',
      densityKgM3: 800,
    })
  ).json().product;
  magazineId = (
    await post(`/sites/${siteId}/magazines`, 'admin', {
      name: 'Upper store',
      netExplosiveLimitKg: 8000,
    })
  ).json().magazine.id;
  batchId = (
    await post(`/products/${product.id}/batches`, 'store', { batchCode: 'L2026-050' })
  ).json().batch.id;
});

afterEach(async () => {
  await harness.close();
});

const movement = { batchId: null, movement: 'receipt', quantity: 400, massKg: 400 };

function receipt(overrides = {}) {
  return { ...movement, batchId, ...overrides };
}

describe('the store', () => {
  it('remembers a response and hands it back', () => {
    const store = createStore();
    store.remember('k1', { status: 201, body: '{}', fingerprint: 'abc' }, 0);
    expect(store.get('k1', 0).status).toBe(201);
  });

  it('forgets one that has gone stale', () => {
    const store = createStore({ ttlMs: 10 });
    store.remember('k1', { status: 201, body: '{}', fingerprint: 'abc' }, 0);
    expect(store.get('k1', 100)).toBe(null);
  });

  it('drops the oldest once it is full', () => {
    const store = createStore({ maximum: 2 });
    store.remember('k1', { status: 200, body: '1', fingerprint: 'a' }, 0);
    store.remember('k2', { status: 200, body: '2', fingerprint: 'b' }, 1);
    store.remember('k3', { status: 200, body: '3', fingerprint: 'c' }, 2);
    expect(store.size()).toBe(2);
    expect(store.get('k1', 3)).toBe(null);
  });

  it('has nothing for a key it never saw', () => {
    expect(createStore().get('nothing', 0)).toBe(null);
  });
});

describe('fingerprint', () => {
  it('is the same for the same request', () => {
    const request = { method: 'POST', url: '/x', body: { a: 1 } };
    expect(fingerprint(request)).toBe(fingerprint({ ...request }));
  });

  it('changes with the body, the path and the method', () => {
    const request = { method: 'POST', url: '/x', body: { a: 1 } };
    expect(fingerprint({ ...request, body: { a: 2 } })).not.toBe(fingerprint(request));
    expect(fingerprint({ ...request, url: '/y' })).not.toBe(fingerprint(request));
    expect(fingerprint({ ...request, method: 'PUT' })).not.toBe(fingerprint(request));
  });
});

describe('a repeated write', () => {
  it('runs once and replays the answer', async () => {
    const headers = { [idempotencyHeader]: 'phone-42' };
    const first = await post(`/magazines/${magazineId}/movements`, 'store', receipt(), headers);
    const second = await post(`/magazines/${magazineId}/movements`, 'store', receipt(), headers);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json().line.id).toBe(first.json().line.id);
    expect(
      (await harness.get(`/magazines/${magazineId}/stock`, 'viewer')).json().stock.netExplosiveKg,
    ).toBe(400);
  });

  it('runs twice without a key, which is the old behaviour', async () => {
    await post(`/magazines/${magazineId}/movements`, 'store', receipt());
    await post(`/magazines/${magazineId}/movements`, 'store', receipt());
    expect(
      (await harness.get(`/magazines/${magazineId}/stock`, 'viewer')).json().stock.netExplosiveKg,
    ).toBe(800);
  });

  it('refuses the same key with a different body', async () => {
    const headers = { [idempotencyHeader]: 'phone-43' };
    await post(`/magazines/${magazineId}/movements`, 'store', receipt(), headers);
    const second = await post(
      `/magazines/${magazineId}/movements`,
      'store',
      receipt({ quantity: 900, massKg: 900 }),
      headers,
    );
    expect(second.statusCode).toBe(409);
    expect(second.json().detail).toContain('different request');
  });

  it('does not remember a request that failed', async () => {
    const headers = { [idempotencyHeader]: 'phone-44' };
    const failed = await post(
      `/magazines/${magazineId}/movements`,
      'store',
      receipt({ movement: 'borrowed' }),
      headers,
    );
    expect(failed.statusCode).toBe(422);
    const retried = await post(`/magazines/${magazineId}/movements`, 'store', receipt(), headers);
    expect(retried.statusCode).toBe(201);
    expect(retried.headers['idempotent-replay']).toBe(undefined);
  });

  it('leaves reads alone', async () => {
    const first = await harness.app.inject({
      method: 'GET',
      url: `/magazines/${magazineId}/stock`,
      headers: { ...harness.as('viewer'), [idempotencyHeader]: 'phone-45' },
    });
    await post(`/magazines/${magazineId}/movements`, 'store', receipt());
    const second = await harness.app.inject({
      method: 'GET',
      url: `/magazines/${magazineId}/stock`,
      headers: { ...harness.as('viewer'), [idempotencyHeader]: 'phone-45' },
    });
    expect(first.json().stock.netExplosiveKg).toBe(0);
    expect(second.json().stock.netExplosiveKg).toBe(400);
  });

  it('keeps two different keys apart', async () => {
    await post(`/magazines/${magazineId}/movements`, 'store', receipt(), {
      [idempotencyHeader]: 'a',
    });
    await post(`/magazines/${magazineId}/movements`, 'store', receipt(), {
      [idempotencyHeader]: 'b',
    });
    expect(
      (await harness.get(`/magazines/${magazineId}/stock`, 'viewer')).json().stock.netExplosiveKg,
    ).toBe(800);
  });
});
