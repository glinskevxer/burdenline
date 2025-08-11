import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { migration as core } from '../../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../../src/db/migrations/003_blasting.js';
import { createSite } from '../../../src/db/repositories/sites.js';
import {
  createProduct,
  getProduct,
  findProductByCode,
  listProducts,
  retireProduct,
  createMagazine,
  getMagazine,
  listMagazines,
  createBatch,
  getBatch,
  listBatches,
  recordMovement,
  correctMovement,
  ledgerFor,
  ledgerForBlast,
  stockFor,
} from '../../../src/db/repositories/explosives.js';
import { fixedClock } from '../../../src/lib/clock.js';
import { NotFoundError, ConflictError, ValidationError } from '../../../src/lib/errors.js';

let db;
let siteId;
let productId;
let magazineId;
let batchId;
const clock = fixedClock('2025-08-12T09:00:00Z');
const context = { clock };

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting]);
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, context).id;
  productId = createProduct(
    db,
    { code: 'ANFO-80', name: 'Ammonium nitrate fuel oil', kind: 'bulk_anfo', densityKgM3: 800 },
    context,
  ).id;
  magazineId = createMagazine(
    db,
    { siteId, name: 'Upper store', netExplosiveLimitKg: 2000 },
    context,
  ).id;
  batchId = createBatch(
    db,
    { productId, batchCode: 'L2025-114', supplier: 'Kilcorney' },
    context,
  ).id;
});

afterEach(() => closeDatabase(db));

describe('products', () => {
  it('creates and reads one back', () => {
    expect(getProduct(db, productId).code).toBe('ANFO-80');
    expect(findProductByCode(db, 'ANFO-80').id).toBe(productId);
  });

  it('refuses two products with the same code', () => {
    expect(() =>
      createProduct(
        db,
        { code: 'ANFO-80', name: 'Another', kind: 'bulk_anfo', densityKgM3: 800 },
        context,
      ),
    ).toThrow(ConflictError);
  });

  it('leaves a retired product out of the list', () => {
    retireProduct(db, productId, context);
    expect(listProducts(db)).toHaveLength(0);
    expect(getProduct(db, productId).retiredAt).not.toBe(null);
  });

  it('filters the list by kind', () => {
    createProduct(
      db,
      { code: 'BST-400', name: 'Booster', kind: 'booster', unitMassKg: 0.4 },
      context,
    );
    expect(listProducts(db, { kind: 'booster' })).toHaveLength(1);
  });
});

describe('magazines and batches', () => {
  it('creates a magazine against a site', () => {
    expect(getMagazine(db, magazineId).netExplosiveLimitKg).toBe(2000);
    expect(listMagazines(db, siteId)).toHaveLength(1);
  });

  it('refuses a magazine on a site that is not there', () => {
    expect(() =>
      createMagazine(db, { siteId: 'site_missing', name: 'x', netExplosiveLimitKg: 100 }, context),
    ).toThrow(NotFoundError);
  });

  it('creates a batch against a product', () => {
    expect(getBatch(db, batchId).batchCode).toBe('L2025-114');
    expect(listBatches(db, productId)).toHaveLength(1);
  });

  it('refuses a batch of a product that is not there', () => {
    expect(() => createBatch(db, { productId: 'prod_missing', batchCode: 'X' }, context)).toThrow(
      NotFoundError,
    );
  });
});

describe('recordMovement', () => {
  function receive(quantity = 1000) {
    return recordMovement(
      db,
      { magazineId, batchId, movement: 'receipt', quantity, massKg: quantity, reference: 'DN-1' },
      context,
    );
  }

  it('appends a receipt with the sign applied', () => {
    const line = receive();
    expect(line.quantity).toBe(1000);
    expect(line.movement).toBe('receipt');
    expect(ledgerFor(db, magazineId)).toHaveLength(1);
  });

  it('writes an issue as a negative line', () => {
    receive();
    const line = recordMovement(
      db,
      { magazineId, batchId, movement: 'issue', quantity: 250, massKg: 250, blastId: null },
      context,
    );
    expect(line.quantity).toBe(-250);
    expect(line.massKg).toBe(-250);
  });

  it('refuses an issue of more than is held', () => {
    receive(100);
    expect(() =>
      recordMovement(
        db,
        { magazineId, batchId, movement: 'issue', quantity: 500, massKg: 500 },
        context,
      ),
    ).toThrow(ConflictError);
  });

  it('names the rules that stopped it', () => {
    receive(100);
    try {
      recordMovement(
        db,
        { magazineId, batchId, movement: 'issue', quantity: 500, massKg: 500 },
        context,
      );
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.details.violations[0].rule).toBe('magazine.insufficient_stock');
    }
  });

  it('refuses a receipt that would break the licence', () => {
    receive(1900);
    expect(() => receive(500)).toThrow(ConflictError);
  });

  it('writes nothing when it refuses', () => {
    receive(100);
    try {
      recordMovement(
        db,
        { magazineId, batchId, movement: 'issue', quantity: 500, massKg: 500 },
        context,
      );
    } catch {
      // expected
    }
    expect(ledgerFor(db, magazineId)).toHaveLength(1);
  });

  it('can be forced past a check, which the stocktake needs', () => {
    receive(100);
    const line = recordMovement(
      db,
      { magazineId, batchId, movement: 'issue', quantity: 500, massKg: 500, force: true },
      context,
    );
    expect(line.quantity).toBe(-500);
  });

  it('joins the product code onto the ledger for reading', () => {
    receive();
    expect(ledgerFor(db, magazineId)[0].productCode).toBe('ANFO-80');
    expect(ledgerFor(db, magazineId)[0].batchCode).toBe('L2025-114');
  });

  it('filters the ledger by date', () => {
    receive();
    expect(ledgerFor(db, magazineId, { from: '2026-01-01T00:00:00.000Z' })).toHaveLength(0);
    expect(ledgerFor(db, magazineId, { to: '2026-01-01T00:00:00.000Z' })).toHaveLength(1);
  });

  it('gathers the lines for one shot', () => {
    receive();
    recordMovement(
      db,
      { magazineId, batchId, movement: 'issue', quantity: 250, massKg: 250, blastId: 'blast_1' },
      context,
    );
    expect(ledgerForBlast(db, 'blast_1')).toHaveLength(1);
  });
});

describe('correctMovement', () => {
  it('writes a correction pointing at the original', () => {
    const original = recordMovement(
      db,
      { magazineId, batchId, movement: 'receipt', quantity: 1000, massKg: 1000 },
      context,
    );
    const correction = correctMovement(
      db,
      { ledgerId: original.id, quantity: -20, reason: 'weighbridge ticket read wrong' },
      context,
    );
    expect(correction.correctsId).toBe(original.id);
    expect(correction.movement).toBe('correction');
    expect(stockFor(db, magazineId).netExplosiveKg).toBe(980);
  });

  it('refuses a correction with no reason', () => {
    const original = recordMovement(
      db,
      { magazineId, batchId, movement: 'receipt', quantity: 1000, massKg: 1000 },
      context,
    );
    expect(() =>
      correctMovement(db, { ledgerId: original.id, quantity: -20, reason: 'oops' }, context),
    ).toThrow(ValidationError);
  });

  it('refuses to correct a line that is not there', () => {
    expect(() =>
      correctMovement(
        db,
        { ledgerId: 'led_missing', quantity: -20, reason: 'a good reason' },
        context,
      ),
    ).toThrow(ValidationError);
  });
});

describe('stockFor', () => {
  it('reads the balance off the ledger', () => {
    recordMovement(
      db,
      { magazineId, batchId, movement: 'receipt', quantity: 1000, massKg: 1000 },
      context,
    );
    recordMovement(
      db,
      { magazineId, batchId, movement: 'issue', quantity: 250, massKg: 250 },
      context,
    );
    const state = stockFor(db, magazineId);
    expect(state.netExplosiveKg).toBe(750);
    expect(state.headroomKg).toBe(1250);
    expect(state.valid).toBe(true);
  });

  it('reads an empty magazine as nothing held', () => {
    expect(stockFor(db, magazineId).netExplosiveKg).toBe(0);
  });

  it('refuses a magazine that is not there', () => {
    expect(() => stockFor(db, 'mag_missing')).toThrow(NotFoundError);
  });
});
