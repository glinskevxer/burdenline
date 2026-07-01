/**
 * What happens when a write goes wrong half way.
 *
 * Every one of these is a place where two tables have to move together, and the
 * failure they guard against is the same: a row that says something happened
 * with nothing behind it. They are worth testing directly because the code that
 * makes them true is a `inTransaction` call that is easy to remove by accident
 * and impossible to notice missing until an inspector asks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase, seedPerson } from '../helpers/database.js';
import { inTransaction, inSavepoint } from '../../src/db/connection.js';
import { createSite, createBench } from '../../src/db/repositories/sites.js';
import { createPattern, replaceHoles, listHoles } from '../../src/db/repositories/patterns.js';
import { createBlast, transition, eventsFor, getBlast } from '../../src/db/repositories/blasts.js';
import {
  createProduct,
  createMagazine,
  createBatch,
  recordMovement,
  ledgerFor,
  stockFor,
} from '../../src/db/repositories/explosives.js';
import { placeOrder, receiveDelivery, listOrders } from '../../src/db/repositories/orders.js';
import {
  recordComplaint,
  advanceComplaint,
  getComplaint,
} from '../../src/db/repositories/community.js';
import { historyFor } from '../../src/db/audit.js';
import { countWhere } from '../../src/db/repository.js';
import { layoutPattern } from '../../src/domain/geometry/pattern.js';
import { fixedClock } from '../../src/lib/clock.js';

let db;
let siteId;
const clock = fixedClock('2026-07-02T09:00:00Z');
const context = { clock, actorId: 'per_1' };

beforeEach(async () => {
  db = await openTestDatabase();
  seedPerson(db);
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, context).id;
});

afterEach(() => closeTestDatabase(db));

describe('a pattern and its holes', () => {
  it('writes none of the holes when one of them is bad', () => {
    const benchId = createBench(
      db,
      {
        siteId,
        name: 'North 60',
        crestLevelM: 84,
        toeLevelM: 69,
        rockType: 'dolerite',
        rockDensityKgM3: 2900,
      },
      context,
    ).id;
    const pattern = createPattern(
      db,
      {
        benchId,
        reference: 'MDW-2026-100',
        holeDiameterMm: 102,
        nominalBurdenM: 3,
        nominalSpacingM: 3.5,
        rowCount: 1,
        holesPerRow: 4,
        benchHeightM: 15,
      },
      context,
    );
    const holes = layoutPattern({
      origin: { easting: 1000, northing: 2000, level: 84 },
      faceBearingDeg: 0,
      layout: 'single_row',
      rowCount: 1,
      holesPerRow: 4,
      burdenM: 3,
      spacingM: 3.5,
      benchHeightM: 15,
      diameterMm: 102,
    }).holes;
    holes[2] = { ...holes[2], diameterMm: -1 };
    expect(() => replaceHoles(db, pattern.id, holes, context)).toThrow();
    expect(listHoles(db, pattern.id)).toEqual([]);
  });
});

describe('a blast transition', () => {
  it('writes the event and the state together or neither', () => {
    const blast = createBlast(db, { siteId, reference: 'MDW-2026-101' }, context);
    expect(() => transition(db, blast.id, 'fire', { shotfirerId: 'per_1' }, context)).toThrow();
    expect(eventsFor(db, blast.id)).toEqual([]);
    expect(getBlast(db, blast.id).state).toBe('draft');
  });

  it('leaves the state alone when the event cannot be written', () => {
    const blast = createBlast(db, { siteId, reference: 'MDW-2026-102' }, context);
    expect(() =>
      transition(db, blast.id, 'complete_design', { actorId: 'per_missing' }, context),
    ).toThrow();
    expect(getBlast(db, blast.id).state).toBe('draft');
    expect(eventsFor(db, blast.id)).toEqual([]);
  });
});

describe('a delivery', () => {
  it('takes nothing in and marks nothing off when one line is wrong', () => {
    const productId = createProduct(
      db,
      { code: 'ANFO-80', name: 'Anfo', kind: 'bulk_anfo', densityKgM3: 800 },
      context,
    ).id;
    createProduct(
      db,
      { code: 'EM-115', name: 'Emulsion', kind: 'bulk_emulsion', densityKgM3: 1150 },
      context,
    );
    const magazineId = createMagazine(
      db,
      { siteId, name: 'Upper store', netExplosiveLimitKg: 8000 },
      context,
    ).id;
    const order = placeOrder(
      db,
      {
        siteId,
        supplier: 'Kilcorney',
        reference: 'PO-9001',
        lines: [
          { productCode: 'ANFO-80', quantity: 2000 },
          { productCode: 'EM-115', quantity: 500 },
        ],
      },
      context,
    );
    expect(() =>
      receiveDelivery(
        db,
        {
          orderId: order.id,
          magazineId,
          items: [
            { productCode: 'ANFO-80', quantity: 1000, batchCode: 'L1' },
            { productCode: 'EM-115', quantity: 9000, batchCode: 'E1' },
          ],
        },
        context,
      ),
    ).toThrow();
    expect(stockFor(db, magazineId).netExplosiveKg).toBe(0);
    expect(listOrders(db, siteId)[0].state).toBe('placed');
    expect(countWhere(db, 'product_batch', { productId })).toBe(0);
  });
});

describe('an audited change', () => {
  it('writes the change and the trail entry together', () => {
    const complaint = recordComplaint(
      db,
      {
        siteId,
        receivedAt: clock.now(),
        channel: 'telephone',
        about: 'dust',
        description: 'dust over the washing every dry day',
      },
      context,
    );
    expect(historyFor(db, 'complaint', complaint.id)).toHaveLength(1);
    expect(() => advanceComplaint(db, complaint.id, 'close', {}, context)).toThrow();
    expect(getComplaint(db, complaint.id).state).toBe('open');
    expect(historyFor(db, 'complaint', complaint.id)).toHaveLength(1);
  });
});

describe('the transaction helpers themselves', () => {
  function seeded() {
    const productId = createProduct(
      db,
      { code: 'ANFO-80', name: 'Anfo', kind: 'bulk_anfo', densityKgM3: 800 },
      context,
    ).id;
    const magazineId = createMagazine(
      db,
      { siteId, name: 'Upper store', netExplosiveLimitKg: 8000 },
      context,
    ).id;
    const batch = createBatch(db, { productId, batchCode: 'L1' }, context);
    return { magazineId, batchId: batch.id };
  }

  it('rolls a whole unit of work back', () => {
    const { magazineId, batchId } = seeded();
    expect(() =>
      inTransaction(db, () => {
        recordMovement(
          db,
          { magazineId, batchId, movement: 'receipt', quantity: 1000, massKg: 1000 },
          context,
        );
        throw new Error('the survey came back wrong');
      }),
    ).toThrow('the survey came back wrong');
    expect(ledgerFor(db, magazineId)).toEqual([]);
  });

  it('rolls only the inner work back when a savepoint fails', () => {
    const { magazineId, batchId } = seeded();
    inTransaction(db, () => {
      recordMovement(
        db,
        { magazineId, batchId, movement: 'receipt', quantity: 1000, massKg: 1000 },
        context,
      );
      try {
        inSavepoint(db, () => {
          recordMovement(
            db,
            { magazineId, batchId, movement: 'issue', quantity: 100, massKg: 100 },
            context,
          );
          throw new Error('the crew went home');
        });
      } catch {
        // the outer unit carries on
      }
    });
    expect(ledgerFor(db, magazineId)).toHaveLength(1);
    expect(stockFor(db, magazineId).netExplosiveKg).toBe(1000);
  });
});
