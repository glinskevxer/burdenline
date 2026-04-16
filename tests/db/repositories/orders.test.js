import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase, seedPerson } from '../../helpers/database.js';
import { createSite } from '../../../src/db/repositories/sites.js';
import {
  createProduct,
  createMagazine,
  createBatch,
  recordMovement,
  stockFor,
} from '../../../src/db/repositories/explosives.js';
import {
  placeOrder,
  getOrder,
  listOrders,
  receiveDelivery,
  cancelOrder,
  onOrder,
  reviewSupply,
  ORDER_STATES,
} from '../../../src/db/repositories/orders.js';
import { fixedClock } from '../../../src/lib/clock.js';
import { NotFoundError, ConflictError, ValidationError } from '../../../src/lib/errors.js';

let db;
let siteId;
let magazineId;
const clock = fixedClock('2026-03-18T09:00:00Z');
const context = { clock, actorId: 'per_1' };

function order(overrides = {}) {
  return placeOrder(
    db,
    {
      siteId,
      supplier: 'Kilcorney Explosives',
      reference: 'PO-1188',
      expectedOn: '2026-03-25',
      lines: [{ productCode: 'ANFO-80', quantity: 4000, unit: 'kg' }],
      ...overrides,
    },
    context,
  );
}

beforeEach(async () => {
  db = await openTestDatabase();
  seedPerson(db);
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, { clock }).id;
  createProduct(
    db,
    { code: 'ANFO-80', name: 'Ammonium nitrate fuel oil', kind: 'bulk_anfo', densityKgM3: 800 },
    { clock },
  );
  createProduct(
    db,
    { code: 'EM-115', name: 'Pumped emulsion', kind: 'bulk_emulsion', densityKgM3: 1150 },
    { clock },
  );
  magazineId = createMagazine(
    db,
    { siteId, name: 'Upper store', netExplosiveLimitKg: 20000 },
    { clock },
  ).id;
});

afterEach(() => closeTestDatabase(db));

describe('placing an order', () => {
  it('writes it with its lines', () => {
    const written = order();
    expect(written.state).toBe('placed');
    expect(written.lines).toHaveLength(1);
    expect(written.outstanding[0].outstanding).toBe(4000);
  });

  it('refuses one with no lines', () => {
    expect(() => order({ lines: [] })).toThrow(ValidationError);
  });

  it('refuses a product nobody stocks', () => {
    expect(() => order({ lines: [{ productCode: 'TNT-1', quantity: 10 }] })).toThrow(
      /no product TNT-1/,
    );
  });

  it('writes nothing at all when a line is bad', () => {
    try {
      order({
        lines: [
          { productCode: 'ANFO-80', quantity: 4000 },
          { productCode: 'TNT-1', quantity: 10 },
        ],
      });
    } catch {
      // expected
    }
    expect(listOrders(db, siteId)).toHaveLength(0);
  });

  it('refuses two orders with the same reference on a site', () => {
    order();
    expect(() => order()).toThrow(ConflictError);
  });

  it('lists them by state', () => {
    order();
    order({ reference: 'PO-1189' });
    expect(listOrders(db, siteId)).toHaveLength(2);
    expect(listOrders(db, siteId, { state: 'delivered' })).toHaveLength(0);
  });

  it('names its states', () => {
    expect(ORDER_STATES).toContain('part_delivered');
  });
});

describe('taking a delivery in', () => {
  it('creates the batch, takes the stock in and marks the line off', () => {
    const written = order();
    const delivered = receiveDelivery(
      db,
      {
        orderId: written.id,
        magazineId,
        deliveryNote: 'DN-4471',
        items: [
          {
            productCode: 'ANFO-80',
            quantity: 4000,
            batchCode: 'L2026-030',
            expiresOn: '2027-03-01',
          },
        ],
      },
      { clock },
    );
    expect(delivered.state).toBe('delivered');
    expect(stockFor(db, magazineId).netExplosiveKg).toBe(4000);
    expect(db.prepare('SELECT batch_code FROM product_batch').get().batch_code).toBe('L2026-030');
  });

  it('marks a part delivery as part delivered', () => {
    const written = order();
    const delivered = receiveDelivery(
      db,
      {
        orderId: written.id,
        magazineId,
        items: [{ productCode: 'ANFO-80', quantity: 1500, batchCode: 'L2026-030' }],
      },
      { clock },
    );
    expect(delivered.state).toBe('part_delivered');
    expect(delivered.outstanding[0].outstanding).toBe(2500);
  });

  it('refuses more than was ordered', () => {
    const written = order();
    expect(() =>
      receiveDelivery(
        db,
        {
          orderId: written.id,
          magazineId,
          items: [{ productCode: 'ANFO-80', quantity: 5000, batchCode: 'L2026-030' }],
        },
        { clock },
      ),
    ).toThrow(/ordered short of that/);
  });

  it('refuses a product that is not on the order', () => {
    const written = order();
    expect(() =>
      receiveDelivery(
        db,
        {
          orderId: written.id,
          magazineId,
          items: [{ productCode: 'EM-115', quantity: 100, batchCode: 'E1' }],
        },
        { clock },
      ),
    ).toThrow(/not on that order/);
  });

  it('takes nothing in when one item of the delivery is wrong', () => {
    const written = order({
      lines: [
        { productCode: 'ANFO-80', quantity: 4000 },
        { productCode: 'EM-115', quantity: 1000 },
      ],
    });
    try {
      receiveDelivery(
        db,
        {
          orderId: written.id,
          magazineId,
          items: [
            { productCode: 'ANFO-80', quantity: 1000, batchCode: 'L1' },
            { productCode: 'EM-115', quantity: 9000, batchCode: 'E1' },
          ],
        },
        { clock },
      );
    } catch {
      // expected
    }
    expect(stockFor(db, magazineId).netExplosiveKg).toBe(0);
  });

  it('refuses a delivery against an order that is finished', () => {
    const written = order();
    receiveDelivery(
      db,
      {
        orderId: written.id,
        magazineId,
        items: [{ productCode: 'ANFO-80', quantity: 4000, batchCode: 'L1' }],
      },
      { clock },
    );
    expect(() =>
      receiveDelivery(
        db,
        {
          orderId: written.id,
          magazineId,
          items: [{ productCode: 'ANFO-80', quantity: 1, batchCode: 'L2' }],
        },
        { clock },
      ),
    ).toThrow(/already delivered/);
  });

  it('refuses a magazine that is not there', () => {
    const written = order();
    expect(() =>
      receiveDelivery(db, { orderId: written.id, magazineId: 'mag_missing', items: [] }, { clock }),
    ).toThrow(NotFoundError);
  });
});

describe('cancelling', () => {
  it('cancels an order nothing has arrived against', () => {
    const written = order();
    expect(cancelOrder(db, written.id, { clock, reason: 'the shot was called off' }).state).toBe(
      'cancelled',
    );
  });

  it('refuses to cancel one that is part delivered', () => {
    const written = order();
    receiveDelivery(
      db,
      {
        orderId: written.id,
        magazineId,
        items: [{ productCode: 'ANFO-80', quantity: 100, batchCode: 'L1' }],
      },
      { clock },
    );
    expect(() => cancelOrder(db, written.id, { clock })).toThrow(ConflictError);
  });
});

describe('onOrder and reviewSupply', () => {
  it('counts what is on order but not yet in', () => {
    order();
    expect(onOrder(db, siteId)).toEqual({ 'ANFO-80': 4000 });
  });

  it('stops counting it once it arrives', () => {
    const written = order();
    receiveDelivery(
      db,
      {
        orderId: written.id,
        magazineId,
        items: [{ productCode: 'ANFO-80', quantity: 4000, batchCode: 'L1' }],
      },
      { clock },
    );
    expect(onOrder(db, siteId)).toEqual({});
  });

  it('reviews the store against what has been used', () => {
    const product = db.prepare("SELECT id FROM product WHERE code = 'ANFO-80'").get();
    const batch = createBatch(db, { productId: product.id, batchCode: 'L2026-001' }, { clock });
    recordMovement(
      db,
      { magazineId, batchId: batch.id, movement: 'receipt', quantity: 4000, massKg: 4000 },
      { clock },
    );
    for (const day of ['2026-02-02', '2026-02-09', '2026-02-16', '2026-02-23']) {
      recordMovement(
        db,
        {
          magazineId,
          batchId: batch.id,
          movement: 'issue',
          quantity: 900,
          massKg: 900,
          occurredAt: `${day}T13:00:00.000Z`,
          force: true,
        },
        { clock },
      );
    }
    const review = reviewSupply(db, siteId);
    const anfo = review.items.find((item) => item.productCode === 'ANFO-80');
    expect(anfo.held).toBe(400);
    expect(anfo.action).not.toBe('none');
  });

  it('refuses a site with no magazine to review', () => {
    const other = createSite(db, { code: 'RCK', name: 'Rockfield' }, { clock });
    expect(() => reviewSupply(db, other.id)).toThrow(NotFoundError);
  });

  it('reads an order back with its outstanding lines', () => {
    const written = order();
    expect(getOrder(db, written.id).outstanding).toHaveLength(1);
  });
});
