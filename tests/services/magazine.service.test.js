import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosivesMigration } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { createSite, createBench } from '../../src/db/repositories/sites.js';
import { createPattern, replaceHoles, listHoles } from '../../src/db/repositories/patterns.js';
import { createBlast, transition, replaceDecks } from '../../src/db/repositories/blasts.js';
import {
  createProduct,
  createMagazine,
  createBatch,
  recordMovement,
  stockFor,
  ledgerForBlast,
} from '../../src/db/repositories/explosives.js';
import { createMagazineService } from '../../src/services/magazine.service.js';
import { layoutPattern } from '../../src/domain/geometry/pattern.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';
import { ConflictError, ValidationError } from '../../src/lib/errors.js';
import { insertRow } from '../../src/db/repository.js';

let db;
let service;
let siteId;
let magazineId;
let productId;
let blastId;
let holes;
const clock = fixedClock('2025-08-19T09:00:00Z');
const context = { clock };

function stock(quantity, overrides = {}) {
  const batch = createBatch(
    db,
    {
      productId,
      batchCode: overrides.batchCode ?? 'L2025-114',
      expiresOn: overrides.expiresOn ?? '2026-06-01',
    },
    context,
  );
  recordMovement(
    db,
    { magazineId, batchId: batch.id, movement: 'receipt', quantity, massKg: quantity },
    context,
  );
  return batch;
}

function approvedBlast() {
  const blast = createBlast(db, { siteId, reference: 'MDW-2025-014' }, context);
  transition(db, blast.id, 'complete_design', {}, context);
  transition(db, blast.id, 'submit', {}, context);
  transition(db, blast.id, 'approve', { approverId: 'per_9' }, context);
  return blast.id;
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosivesMigration, blasting, operations]);
  service = createMagazineService({ db, clock, logger: silentLogger() });
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, context).id;
  insertRow(db, 'person', {
    id: 'per_9',
    name: 'J Ryan',
    roles: 'manager',
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
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
      reference: 'MDW-2025-014-P',
      holeDiameterMm: 102,
      nominalBurdenM: 3,
      nominalSpacingM: 3.5,
      rowCount: 1,
      holesPerRow: 4,
      benchHeightM: 15,
    },
    context,
  );
  replaceHoles(
    db,
    pattern.id,
    layoutPattern({
      origin: { easting: 1000, northing: 2000, level: 84 },
      faceBearingDeg: 0,
      layout: 'single_row',
      rowCount: 1,
      holesPerRow: 4,
      burdenM: 3,
      spacingM: 3.5,
      benchHeightM: 15,
      subdrillM: 1,
      diameterMm: 102,
    }).holes,
    context,
  );
  holes = listHoles(db, pattern.id);
  productId = createProduct(
    db,
    { code: 'ANFO-80', name: 'Ammonium nitrate fuel oil', kind: 'bulk_anfo', densityKgM3: 800 },
    context,
  ).id;
  magazineId = createMagazine(
    db,
    { siteId, name: 'Upper store', netExplosiveLimitKg: 4000 },
    context,
  ).id;
  blastId = approvedBlast();
});

afterEach(() => closeDatabase(db));

describe('issueForBlast', () => {
  it('issues from stock and writes a ledger line', () => {
    stock(1000);
    const result = service.issueForBlast({
      blastId,
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 400 }],
    });
    expect(result.totalKg).toBe(400);
    expect(stockFor(db, magazineId).netExplosiveKg).toBe(600);
  });

  it('draws from the batch that expires first', () => {
    stock(200, { batchCode: 'LATE', expiresOn: '2027-01-01' });
    const early = stock(300, { batchCode: 'EARLY', expiresOn: '2025-12-01' });
    const result = service.issueForBlast({
      blastId,
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 250 }],
    });
    expect(result.lines[0].batchId).toBe(early.id);
  });

  it('spills into a second batch and writes a line for each', () => {
    stock(200, { batchCode: 'A', expiresOn: '2025-12-01' });
    stock(300, { batchCode: 'B', expiresOn: '2026-03-01' });
    const result = service.issueForBlast({
      blastId,
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 400 }],
    });
    expect(result.lines).toHaveLength(2);
  });

  it('refuses when there is not enough stock', () => {
    stock(100);
    expect(() =>
      service.issueForBlast({
        blastId,
        magazineId,
        items: [{ productCode: 'ANFO-80', quantity: 400 }],
      }),
    ).toThrow(/not enough ANFO-80/);
  });

  it('refuses to issue expired stock', () => {
    stock(1000, { expiresOn: '2025-01-01' });
    expect(() =>
      service.issueForBlast({
        blastId,
        magazineId,
        items: [{ productCode: 'ANFO-80', quantity: 100 }],
      }),
    ).toThrow(ConflictError);
  });

  it('refuses a product nobody stocks', () => {
    stock(1000);
    expect(() =>
      service.issueForBlast({
        blastId,
        magazineId,
        items: [{ productCode: 'TNT-1', quantity: 10 }],
      }),
    ).toThrow(ValidationError);
  });

  it('refuses to issue to a shot that has not been approved', () => {
    stock(1000);
    const draft = createBlast(db, { siteId, reference: 'MDW-2025-015' }, context);
    expect(() =>
      service.issueForBlast({
        blastId: draft.id,
        magazineId,
        items: [{ productCode: 'ANFO-80', quantity: 100 }],
      }),
    ).toThrow(/cannot be issued to a shot that is draft/);
  });
});

describe('consumeForBlast', () => {
  function loaded() {
    const batch = stock(1000);
    service.issueForBlast({
      blastId,
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 400 }],
    });
    replaceDecks(
      db,
      blastId,
      holes.map((hole) => ({
        holeId: hole.id,
        deckNumber: 1,
        kind: 'charge',
        fromToeM: 0,
        toToeM: 13,
        massKg: 95,
        batchId: batch.id,
        primed: true,
      })),
      context,
    );
    return batch;
  }

  it('takes the mass off the load sheet', () => {
    loaded();
    const result = service.consumeForBlast({ blastId, magazineId });
    expect(result.totalKg).toBe(380);
  });

  it('leaves the difference showing as unreturned', () => {
    loaded();
    service.consumeForBlast({ blastId, magazineId });
    const reconciliation = service.reconcile({ blastId });
    expect(reconciliation.products[0].unaccounted).toBe(20);
  });

  it('refuses when nothing was issued', () => {
    expect(() => service.consumeForBlast({ blastId, magazineId })).toThrow(/nothing was issued/);
  });
});

describe('returnFromBlast and reconcile', () => {
  it('balances a shot once the surplus comes back', () => {
    const batch = stock(1000);
    service.issueForBlast({
      blastId,
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 400 }],
    });
    replaceDecks(
      db,
      blastId,
      holes.map((hole) => ({
        holeId: hole.id,
        deckNumber: 1,
        kind: 'charge',
        fromToeM: 0,
        toToeM: 13,
        massKg: 95,
        batchId: batch.id,
        primed: true,
      })),
      context,
    );
    service.consumeForBlast({ blastId, magazineId });
    service.returnFromBlast({
      blastId,
      magazineId,
      items: [{ batchId: batch.id, quantity: 20, massKg: 20 }],
    });
    const reconciliation = service.reconcile({ blastId });
    expect(reconciliation.balanced).toBe(true);
    expect(reconciliation.report).toBe(null);
    expect(ledgerForBlast(db, blastId)).toHaveLength(3);
  });

  it('writes a discrepancy report when it does not balance', () => {
    const batch = stock(1000);
    service.issueForBlast({
      blastId,
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 400 }],
    });
    replaceDecks(
      db,
      blastId,
      [
        {
          holeId: holes[0].id,
          deckNumber: 1,
          kind: 'charge',
          fromToeM: 0,
          toToeM: 13,
          massKg: 95,
          batchId: batch.id,
          primed: true,
        },
      ],
      context,
    );
    service.consumeForBlast({ blastId, magazineId });
    const reconciliation = service.reconcile({ blastId });
    expect(reconciliation.balanced).toBe(false);
    expect(reconciliation.report.totalItems).toBe(1);
  });
});

describe('daybook', () => {
  it('writes the day off the ledger', () => {
    stock(1000);
    service.issueForBlast({
      blastId,
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: 400 }],
    });
    const book = service.daybook({ siteId, magazineId, date: '2025-08-19' });
    expect(book.day.entries).toHaveLength(2);
    expect(book.day.closingBalances['ANFO-80']).toBe(600);
    expect(book.csv.split('\n')[0]).toContain('entry_date');
  });

  it('verifies against the ledger it came from', () => {
    stock(1000);
    const book = service.daybook({ siteId, magazineId, date: '2025-08-19' });
    expect(book.verification.entryCount).toBe(book.verification.ledgerCount);
  });
});
