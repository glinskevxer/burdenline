import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';
import { parseCsvRecords } from '../../src/lib/csv.js';

let harness;
let siteId;
let magazineId;
let productId;
let batchId;

const at = '2025-10-02T09:00:00.000Z';

async function post(url, role, payload) {
  return harness.app.inject({ method: 'POST', url, headers: harness.as(role), payload });
}

beforeEach(async () => {
  harness = await standUp({ at });
  siteId = (await post('/sites', 'admin', { code: 'MDW', name: 'Midway' })).json().site.id;
  magazineId = (
    await post(`/sites/${siteId}/magazines`, 'admin', {
      name: 'Upper store',
      netExplosiveLimitKg: 2000,
    })
  ).json().magazine.id;
  productId = (
    await post('/products', 'admin', {
      code: 'ANFO-80',
      name: 'Ammonium nitrate fuel oil',
      kind: 'bulk_anfo',
      densityKgM3: 800,
    })
  ).json().product.id;
  batchId = (
    await post(`/products/${productId}/batches`, 'store', {
      batchCode: 'L2025-114',
      expiresOn: '2026-06-01',
      supplier: 'Kilcorney',
    })
  ).json().batch.id;
});

afterEach(async () => {
  await harness.close();
});

async function receive(quantity = 1000) {
  return post(`/magazines/${magazineId}/movements`, 'store', {
    batchId,
    movement: 'receipt',
    quantity,
    massKg: quantity,
    reference: 'DN-88213',
  });
}

describe('magazines', () => {
  it('creates one and lists it with its stock', async () => {
    const response = await harness.get(`/sites/${siteId}/magazines`, 'viewer');
    expect(response.json().magazines).toHaveLength(1);
    expect(response.json().magazines[0].stock.netExplosiveKg).toBe(0);
  });

  it('refuses a licence limit of zero', async () => {
    const response = await post(`/sites/${siteId}/magazines`, 'admin', {
      name: 'Lower store',
      netExplosiveLimitKg: 0,
    });
    expect(response.statusCode).toBe(422);
  });

  it('keeps a store hand from creating a magazine', async () => {
    const response = await post(`/sites/${siteId}/magazines`, 'store', {
      name: 'Lower store',
      netExplosiveLimitKg: 500,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('movements', () => {
  it('takes a receipt and moves the balance', async () => {
    expect((await receive()).statusCode).toBe(201);
    expect(
      (await harness.get(`/magazines/${magazineId}/stock`, 'viewer')).json().stock.netExplosiveKg,
    ).toBe(1000);
  });

  it('signs an issue negative without the caller doing it', async () => {
    await receive();
    const response = await post(`/magazines/${magazineId}/movements`, 'store', {
      batchId,
      movement: 'issue',
      quantity: 250,
      massKg: 250,
    });
    expect(response.json().line.quantity).toBe(-250);
  });

  it('refuses an issue of more than is held', async () => {
    await receive(100);
    const response = await post(`/magazines/${magazineId}/movements`, 'store', {
      batchId,
      movement: 'issue',
      quantity: 500,
      massKg: 500,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().details.violations[0].rule).toBe('magazine.insufficient_stock');
  });

  it('refuses a receipt that would break the licence', async () => {
    await receive(1900);
    expect((await receive(500)).statusCode).toBe(409);
  });

  it('refuses a movement nobody records', async () => {
    const response = await post(`/magazines/${magazineId}/movements`, 'store', {
      batchId,
      movement: 'borrowed',
      quantity: 10,
    });
    expect(response.statusCode).toBe(422);
  });

  it('has no route to delete a line', async () => {
    await receive();
    const line = (await harness.get(`/magazines/${magazineId}/ledger`, 'viewer')).json().lines[0];
    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/magazines/${magazineId}/movements/${line.id}`,
      headers: harness.as('admin'),
    });
    expect(response.statusCode).toBe(404);
  });

  it('corrects a line instead, leaving the original standing', async () => {
    await receive();
    const line = (await harness.get(`/magazines/${magazineId}/ledger`, 'viewer')).json().lines[0];
    const response = await post(`/magazines/${magazineId}/corrections`, 'store', {
      ledgerId: line.id,
      quantity: -20,
      reason: 'weighbridge ticket read wrong',
    });
    expect(response.statusCode).toBe(201);
    const ledger = (await harness.get(`/magazines/${magazineId}/ledger`, 'viewer')).json().lines;
    expect(ledger).toHaveLength(2);
    expect(ledger[1].correctsId).toBe(line.id);
  });

  it('refuses a correction with no reason', async () => {
    await receive();
    const line = (await harness.get(`/magazines/${magazineId}/ledger`, 'viewer')).json().lines[0];
    const response = await post(`/magazines/${magazineId}/corrections`, 'store', {
      ledgerId: line.id,
      quantity: -20,
      reason: 'oops',
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('issuing to a shot', () => {
  async function approvedBlast() {
    const blastId = (
      await post(`/sites/${siteId}/blasts`, 'designer', { reference: 'MDW-2025-014' })
    ).json().blast.id;
    await post(`/blasts/${blastId}/complete-design`, 'designer');
    await post(`/blasts/${blastId}/submit`, 'designer');
    await post(`/blasts/${blastId}/approve`, 'manager');
    return blastId;
  }

  it('issues and reports what was drawn', async () => {
    await receive();
    const blastId = await approvedBlast();
    const response = await post(`/blasts/${blastId}/issues`, 'store', {
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 400 }],
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().totalKg).toBe(400);
  });

  it('refuses to issue more than is in the magazine', async () => {
    await receive(100);
    const blastId = await approvedBlast();
    const response = await post(`/blasts/${blastId}/issues`, 'store', {
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 400 }],
    });
    expect(response.statusCode).toBe(409);
  });

  it('reports the reconciliation for a shot', async () => {
    await receive();
    const blastId = await approvedBlast();
    await post(`/blasts/${blastId}/issues`, 'store', {
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 400 }],
    });
    const response = await harness.get(`/blasts/${blastId}/reconciliation`, 'viewer');
    expect(response.json().balanced).toBe(false);
    expect(response.json().products[0].issued).toBe(400);
  });
});

describe('the day-book', () => {
  it('comes back as a csv file for the day asked for', async () => {
    await receive();
    const response = await harness.get(
      `/magazines/${magazineId}/daybook.csv?date=2025-10-02`,
      'viewer',
    );
    expect(response.headers['content-disposition']).toContain('daybook-2025-10-02.csv');
    const { records } = parseCsvRecords(response.payload);
    expect(records).toHaveLength(1);
    expect(records[0].balance).toBe('1000');
  });

  it('comes back empty for a quiet day', async () => {
    const response = await harness.get(
      `/magazines/${magazineId}/daybook.csv?date=2025-10-03`,
      'viewer',
    );
    expect(parseCsvRecords(response.payload).records).toHaveLength(0);
  });
});
