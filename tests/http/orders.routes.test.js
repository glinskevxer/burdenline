import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';

let harness;
let siteId;
let magazineId;

async function post(url, role, payload) {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: harness.as(role),
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function get(url, role) {
  return harness.app.inject({ method: 'GET', url, headers: harness.as(role) });
}

async function order(overrides = {}) {
  return post(`/sites/${siteId}/orders`, 'store', {
    supplier: 'Kilcorney Explosives',
    reference: 'PO-1188',
    expectedOn: '2026-04-01',
    lines: [{ productCode: 'ANFO-80', quantity: 4000, unit: 'kg' }],
    ...overrides,
  });
}

beforeEach(async () => {
  harness = await standUp({ at: '2026-03-24T09:00:00.000Z' });
  siteId = (await post('/sites', 'admin', { code: 'MDW', name: 'Midway' })).json().site.id;
  await post('/products', 'admin', {
    code: 'ANFO-80',
    name: 'Ammonium nitrate fuel oil',
    kind: 'bulk_anfo',
    densityKgM3: 800,
  });
  magazineId = (
    await post(`/sites/${siteId}/magazines`, 'admin', {
      name: 'Upper store',
      netExplosiveLimitKg: 20000,
    })
  ).json().magazine.id;
});

afterEach(async () => {
  await harness.close();
});

describe('placing an order', () => {
  it('takes one and lists it as outstanding', async () => {
    expect((await order()).statusCode).toBe(201);
    const response = await get(`/sites/${siteId}/orders`, 'viewer');
    expect(response.json().orders).toHaveLength(1);
    expect(response.json().onOrder['ANFO-80']).toBe(4000);
  });

  it('refuses an order with no lines', async () => {
    expect((await order({ lines: [] })).statusCode).toBe(422);
  });

  it('refuses a product nobody stocks', async () => {
    expect((await order({ lines: [{ productCode: 'TNT-1', quantity: 10 }] })).statusCode).toBe(422);
  });

  it('refuses the same reference twice', async () => {
    await order();
    expect((await order()).statusCode).toBe(409);
  });

  it('keeps a designer out of ordering', async () => {
    const response = await post(`/sites/${siteId}/orders`, 'designer', {
      supplier: 'Kilcorney Explosives',
      reference: 'PO-2',
      lines: [{ productCode: 'ANFO-80', quantity: 10 }],
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('taking a delivery', () => {
  it('takes the stock in and marks the order delivered', async () => {
    const orderId = (await order()).json().order.id;
    const response = await post(`/orders/${orderId}/deliveries`, 'store', {
      magazineId,
      deliveryNote: 'DN-4471',
      items: [
        { productCode: 'ANFO-80', quantity: 4000, batchCode: 'L2026-030', expiresOn: '2027-03-01' },
      ],
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().order.state).toBe('delivered');
    expect(
      (await get(`/magazines/${magazineId}/stock`, 'viewer')).json().stock.netExplosiveKg,
    ).toBe(4000);
  });

  it('marks a part delivery part delivered', async () => {
    const orderId = (await order()).json().order.id;
    const response = await post(`/orders/${orderId}/deliveries`, 'store', {
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 1500, batchCode: 'L1' }],
    });
    expect(response.json().order.state).toBe('part_delivered');
    expect(response.json().order.outstanding[0].outstanding).toBe(2500);
  });

  it('refuses more than was ordered', async () => {
    const orderId = (await order()).json().order.id;
    const response = await post(`/orders/${orderId}/deliveries`, 'store', {
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 9000, batchCode: 'L1' }],
    });
    expect(response.statusCode).toBe(409);
  });

  it('refuses a delivery with no batch code on it', async () => {
    const orderId = (await order()).json().order.id;
    const response = await post(`/orders/${orderId}/deliveries`, 'store', {
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 100 }],
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('cancelling and reviewing', () => {
  it('cancels one nothing has arrived against', async () => {
    const orderId = (await order()).json().order.id;
    const response = await post(`/orders/${orderId}/cancel`, 'store', {
      reason: 'the shot was called off',
    });
    expect(response.json().order.state).toBe('cancelled');
  });

  it('refuses to cancel one that is part delivered', async () => {
    const orderId = (await order()).json().order.id;
    await post(`/orders/${orderId}/deliveries`, 'store', {
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 100, batchCode: 'L1' }],
    });
    expect((await post(`/orders/${orderId}/cancel`, 'store')).statusCode).toBe(409);
  });

  it('reviews the store and says what to order', async () => {
    const response = await get(`/sites/${siteId}/supply-review`, 'viewer');
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().items)).toBe(true);
  });

  it('answers 404 for a site with no magazine at all', async () => {
    const other = (await post('/sites', 'admin', { code: 'RCK', name: 'Rockfield' })).json().site
      .id;
    expect((await get(`/sites/${other}/supply-review`, 'viewer')).statusCode).toBe(404);
  });
});
