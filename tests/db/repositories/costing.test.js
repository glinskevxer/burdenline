import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { migration as core } from '../../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../../src/db/migrations/004_operations.js';
import { createSite } from '../../../src/db/repositories/sites.js';
import { createProduct } from '../../../src/db/repositories/explosives.js';
import {
  setPrice,
  priceHistory,
  priceBook,
  currentPrice,
  setRate,
  rateBook,
  currentRate,
  endPrice,
  rateUnits,
} from '../../../src/db/repositories/costing.js';
import { fixedClock } from '../../../src/lib/clock.js';
import { NotFoundError, ConflictError, ValidationError } from '../../../src/lib/errors.js';

let db;
let siteId;
let productId;
const clock = fixedClock('2025-12-10T09:00:00Z');
const context = { clock };

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations]);
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, context).id;
  productId = createProduct(
    db,
    { code: 'ANFO-80', name: 'Ammonium nitrate fuel oil', kind: 'bulk_anfo', densityKgM3: 800 },
    context,
  ).id;
});

afterEach(() => closeDatabase(db));

describe('prices', () => {
  it('sets one that runs from today', () => {
    const price = setPrice(db, { productId, pricePerUnit: 1.1, unit: 'kg' }, context);
    expect(price.effectiveFrom).toBe('2025-12-10');
    expect(price.effectiveTo).toBe(null);
  });

  it('closes the old price when a new one starts', () => {
    setPrice(db, { productId, pricePerUnit: 1.1, effectiveFrom: '2025-01-01' }, context);
    setPrice(db, { productId, pricePerUnit: 1.35, effectiveFrom: '2025-07-01' }, context);
    const history = priceHistory(db, productId);
    expect(history).toHaveLength(2);
    expect(history[1].effectiveTo).toBe('2025-07-01');
    expect(history[0].effectiveTo).toBe(null);
  });

  it('still costs an old shot at the old price', () => {
    setPrice(db, { productId, pricePerUnit: 1.1, effectiveFrom: '2025-01-01' }, context);
    setPrice(db, { productId, pricePerUnit: 1.35, effectiveFrom: '2025-07-01' }, context);
    expect(currentPrice(db, 'ANFO-80', '2025-03-01').pricePerUnit).toBe(1.1);
    expect(currentPrice(db, 'ANFO-80', '2025-09-01').pricePerUnit).toBe(1.35);
  });

  it('reads the whole book in the shape the costing wants', () => {
    setPrice(db, { productId, pricePerUnit: 1.1, effectiveFrom: '2025-01-01' }, context);
    expect(priceBook(db)[0]).toMatchObject({ productCode: 'ANFO-80', pricePerUnit: 1.1 });
  });

  it('refuses a negative price', () => {
    expect(() => setPrice(db, { productId, pricePerUnit: -1 }, context)).toThrow(ValidationError);
  });

  it('refuses a price for a product that is not there', () => {
    expect(() => setPrice(db, { productId: 'prod_missing', pricePerUnit: 1 }, context)).toThrow(
      NotFoundError,
    );
  });

  it('has no price before the first one started', () => {
    setPrice(db, { productId, pricePerUnit: 1.1, effectiveFrom: '2025-01-01' }, context);
    expect(currentPrice(db, 'ANFO-80', '2024-01-01')).toBe(null);
  });
});

describe('ending a price', () => {
  it('closes one without opening another', () => {
    const price = setPrice(
      db,
      { productId, pricePerUnit: 1.1, effectiveFrom: '2025-01-01' },
      context,
    );
    const ended = endPrice(db, price.id, { clock, on: '2025-12-31' });
    expect(ended.effectiveTo).toBe('2025-12-31');
    expect(currentPrice(db, 'ANFO-80', '2026-01-05')).toBe(null);
  });

  it('refuses to end one twice', () => {
    const price = setPrice(
      db,
      { productId, pricePerUnit: 1.1, effectiveFrom: '2025-01-01' },
      context,
    );
    endPrice(db, price.id, { clock, on: '2025-12-31' });
    expect(() => endPrice(db, price.id, { clock, on: '2026-01-31' })).toThrow(ConflictError);
  });

  it('refuses an end date before the start', () => {
    const price = setPrice(
      db,
      { productId, pricePerUnit: 1.1, effectiveFrom: '2025-06-01' },
      context,
    );
    expect(() => endPrice(db, price.id, { clock, on: '2025-01-01' })).toThrow(ValidationError);
  });
});

describe('rates', () => {
  it('sets one for a kind of work', () => {
    const rate = setRate(db, { siteId, kind: 'drilling', rate: 6.5, unit: 'metre' }, context);
    expect(rate.kind).toBe('drilling');
    expect(currentRate(db, siteId, 'drilling', '2025-12-11').rate).toBe(6.5);
  });

  it('closes the old rate when a new one starts', () => {
    setRate(
      db,
      { siteId, kind: 'drilling', rate: 6.5, unit: 'metre', effectiveFrom: '2025-01-01' },
      context,
    );
    setRate(
      db,
      { siteId, kind: 'drilling', rate: 7.2, unit: 'metre', effectiveFrom: '2025-09-01' },
      context,
    );
    expect(currentRate(db, siteId, 'drilling', '2025-05-01').rate).toBe(6.5);
    expect(currentRate(db, siteId, 'drilling', '2025-10-01').rate).toBe(7.2);
  });

  it('keeps the rates of different kinds apart', () => {
    setRate(db, { siteId, kind: 'drilling', rate: 6.5, unit: 'metre' }, context);
    setRate(db, { siteId, kind: 'labour', rate: 42, unit: 'hour' }, context);
    expect(rateBook(db, siteId)).toHaveLength(2);
    expect(currentRate(db, siteId, 'labour', '2025-12-11').rate).toBe(42);
  });

  it('refuses a kind nobody accounts for', () => {
    expect(() =>
      setRate(db, { siteId, kind: 'catering', rate: 10, unit: 'hour' }, context),
    ).toThrow(ValidationError);
  });

  it('refuses a unit nothing is charged in', () => {
    expect(() =>
      setRate(db, { siteId, kind: 'labour', rate: 10, unit: 'furlong' }, context),
    ).toThrow(ValidationError);
    expect(rateUnits).toContain('hour');
  });

  it('refuses a rate for a site that is not there', () => {
    expect(() =>
      setRate(db, { siteId: 'site_missing', kind: 'labour', rate: 10, unit: 'hour' }, context),
    ).toThrow(NotFoundError);
  });

  it('has no rate for a kind nobody has set', () => {
    expect(currentRate(db, siteId, 'monitoring', '2025-12-11')).toBe(null);
  });
});
