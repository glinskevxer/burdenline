/**
 * The explosives side, end to end.
 *
 * Order, delivery, issue to a shot, consumption, return, reconciliation and the
 * day-book, over HTTP with nothing stubbed. The numbers are checked at every
 * step against the ledger, because the whole point of the magazine code is that
 * the day-book and the stock can never disagree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from '../http/helpers.js';
import { parseCsvRecords } from '../../src/lib/csv.js';

let harness;
let siteId;
let magazineId;

const at = '2026-04-21T09:00:00.000Z';

function ok(response, code = 200) {
  if (response.statusCode !== code) {
    throw new Error(`${response.statusCode}: ${response.payload}`);
  }
  return response.json();
}

beforeEach(async () => {
  harness = await standUp({ at });
  siteId = ok(await harness.post('/sites', 'admin', { code: 'MDW', name: 'Midway Quarry' }), 201)
    .site.id;
  ok(
    await harness.post('/products', 'admin', {
      code: 'ANFO-80',
      name: 'Ammonium nitrate fuel oil',
      kind: 'bulk_anfo',
      densityKgM3: 800,
      relativeWeightStrength: 100,
      minimumDiameterMm: 50,
    }),
    201,
  );
  magazineId = ok(
    await harness.post(`/sites/${siteId}/magazines`, 'admin', {
      name: 'Upper store',
      licenceNumber: 'MAG-1188',
      netExplosiveLimitKg: 8000,
    }),
    201,
  ).magazine.id;
});

afterEach(async () => {
  await harness.close();
});

describe('from an order to the day-book', () => {
  it('carries the same kilograms all the way through', async () => {
    // Order it.
    const order = ok(
      await harness.post(`/sites/${siteId}/orders`, 'store', {
        supplier: 'Kilcorney Explosives',
        reference: 'PO-2026-014',
        expectedOn: '2026-04-28',
        lines: [{ productCode: 'ANFO-80', quantity: 4000, unit: 'kg' }],
      }),
      201,
    ).order;
    expect(ok(await harness.get(`/sites/${siteId}/orders`, 'viewer')).onOrder['ANFO-80']).toBe(
      4000,
    );

    // It arrives, in two loads.
    ok(
      await harness.post(`/orders/${order.id}/deliveries`, 'store', {
        magazineId,
        deliveryNote: 'DN-9001',
        items: [
          {
            productCode: 'ANFO-80',
            quantity: 2500,
            batchCode: 'L2026-050',
            expiresOn: '2027-04-01',
          },
        ],
      }),
      201,
    );
    const second = ok(
      await harness.post(`/orders/${order.id}/deliveries`, 'store', {
        magazineId,
        deliveryNote: 'DN-9014',
        items: [
          {
            productCode: 'ANFO-80',
            quantity: 1500,
            batchCode: 'L2026-061',
            expiresOn: '2027-05-01',
          },
        ],
      }),
      201,
    ).order;
    expect(second.state).toBe('delivered');
    expect(
      ok(await harness.get(`/magazines/${magazineId}/stock`, 'viewer')).stock.netExplosiveKg,
    ).toBe(4000);

    // A shot to issue it to.
    const blast = ok(
      await harness.post(`/sites/${siteId}/blasts`, 'designer', { reference: 'MDW-2026-014' }),
      201,
    ).blast;
    ok(await harness.post(`/blasts/${blast.id}/complete-design`, 'designer'));
    ok(await harness.post(`/blasts/${blast.id}/submit`, 'designer'));
    ok(await harness.post(`/blasts/${blast.id}/approve`, 'manager'));

    // Issued: the oldest batch goes first.
    const issued = ok(
      await harness.post(`/blasts/${blast.id}/issues`, 'store', {
        magazineId,
        items: [{ productCode: 'ANFO-80', quantity: 2800 }],
      }),
      201,
    );
    expect(issued.totalKg).toBe(2800);
    expect(issued.lines).toHaveLength(2);
    expect(
      ok(await harness.get(`/magazines/${magazineId}/stock`, 'viewer')).stock.netExplosiveKg,
    ).toBe(1200);

    // What went down the holes, and what came back.
    const ledger = ok(await harness.get(`/magazines/${magazineId}/ledger`, 'viewer')).lines;
    const firstBatch = ledger.find((line) => line.batchCode === 'L2026-050').batchId;
    ok(
      await harness.post(`/magazines/${magazineId}/movements`, 'store', {
        batchId: firstBatch,
        movement: 'consumption',
        quantity: 2650,
        massKg: 2650,
        blastId: blast.id,
      }),
      201,
    );
    ok(
      await harness.post(`/magazines/${magazineId}/movements`, 'store', {
        batchId: firstBatch,
        movement: 'return',
        quantity: 150,
        massKg: 150,
        blastId: blast.id,
      }),
      201,
    );

    const reconciliation = ok(await harness.get(`/blasts/${blast.id}/reconciliation`, 'viewer'));
    expect(reconciliation.balanced).toBe(true);
    expect(reconciliation.totalIssued).toBe(2800);
    expect(reconciliation.totalConsumed).toBe(2650);

    // The store is back to what the arithmetic says it should be.
    expect(
      ok(await harness.get(`/magazines/${magazineId}/stock`, 'viewer')).stock.netExplosiveKg,
    ).toBe(1350);

    // And the day-book says the same thing, line by line.
    const daybook = await harness.get(
      `/magazines/${magazineId}/daybook.csv?date=2026-04-21`,
      'viewer',
    );
    const { records } = parseCsvRecords(daybook.payload);
    expect(records).toHaveLength(6);
    expect(Number(records.at(-1).balance)).toBe(1350);
    expect(records.map((record) => record.movement)).toEqual([
      'receipt',
      'receipt',
      'issue',
      'issue',
      'consumption',
      'return',
    ]);
  });

  it('refuses to issue more than the store holds and leaves the ledger alone', async () => {
    const order = ok(
      await harness.post(`/sites/${siteId}/orders`, 'store', {
        supplier: 'Kilcorney Explosives',
        reference: 'PO-2026-015',
        lines: [{ productCode: 'ANFO-80', quantity: 500 }],
      }),
      201,
    ).order;
    ok(
      await harness.post(`/orders/${order.id}/deliveries`, 'store', {
        magazineId,
        items: [{ productCode: 'ANFO-80', quantity: 500, batchCode: 'L2026-070' }],
      }),
      201,
    );
    const blast = ok(
      await harness.post(`/sites/${siteId}/blasts`, 'designer', { reference: 'MDW-2026-015' }),
      201,
    ).blast;
    ok(await harness.post(`/blasts/${blast.id}/complete-design`, 'designer'));
    ok(await harness.post(`/blasts/${blast.id}/submit`, 'designer'));
    ok(await harness.post(`/blasts/${blast.id}/approve`, 'manager'));

    const refused = await harness.post(`/blasts/${blast.id}/issues`, 'store', {
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 900 }],
    });
    expect(refused.statusCode).toBe(409);
    expect(ok(await harness.get(`/magazines/${magazineId}/ledger`, 'viewer')).lines).toHaveLength(
      1,
    );
    expect(
      ok(await harness.get(`/magazines/${magazineId}/stock`, 'viewer')).stock.netExplosiveKg,
    ).toBe(500);
  });

  it('says the store needs ordering once the history shows it going out', async () => {
    const order = ok(
      await harness.post(`/sites/${siteId}/orders`, 'store', {
        supplier: 'Kilcorney Explosives',
        reference: 'PO-2026-016',
        lines: [{ productCode: 'ANFO-80', quantity: 4000 }],
      }),
      201,
    ).order;
    ok(
      await harness.post(`/orders/${order.id}/deliveries`, 'store', {
        magazineId,
        items: [{ productCode: 'ANFO-80', quantity: 4000, batchCode: 'L2026-080' }],
      }),
      201,
    );
    const batchId = ok(await harness.get(`/magazines/${magazineId}/ledger`, 'viewer')).lines[0]
      .batchId;
    for (const day of ['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30']) {
      ok(
        await harness.post(`/magazines/${magazineId}/movements`, 'store', {
          batchId,
          movement: 'issue',
          quantity: 700,
          massKg: 700,
          occurredAt: `${day}T13:00:00.000Z`,
        }),
        201,
      );
    }
    const review = ok(await harness.get(`/sites/${siteId}/supply-review`, 'viewer'));
    const anfo = review.items.find((item) => item.productCode === 'ANFO-80');
    expect(anfo.held).toBe(500);
    expect(anfo.action).not.toBe('none');
    expect(anfo.suggestedQuantity).toBeGreaterThan(0);
  });
});
