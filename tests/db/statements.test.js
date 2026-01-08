import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosivesMigration } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { prepared, cacheSize, clearCache, queries } from '../../src/db/statements.js';
import { createSite } from '../../src/db/repositories/sites.js';
import {
  createProduct,
  createMagazine,
  createBatch,
  recordMovement,
  ledgerFor,
} from '../../src/db/repositories/explosives.js';
import { fixedClock } from '../../src/lib/clock.js';

let db;
let other;
const clock = fixedClock('2026-01-15T09:00:00Z');

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosivesMigration, blasting, operations]);
});

afterEach(() => {
  closeDatabase(db);
  if (other) {
    closeDatabase(other);
    other = undefined;
  }
});

describe('prepared', () => {
  it('compiles once and hands the same statement back', () => {
    const sql = 'SELECT count(*) AS n FROM site';
    const first = prepared(db, sql);
    const second = prepared(db, sql);
    expect(second).toBe(first);
    expect(cacheSize(db)).toBe(1);
  });

  it('keeps different statements apart', () => {
    prepared(db, 'SELECT count(*) AS n FROM site');
    prepared(db, 'SELECT count(*) AS n FROM bench');
    expect(cacheSize(db)).toBe(2);
  });

  it('keeps a cache per connection', () => {
    other = openDatabase({ database: { file: ':memory:' } });
    runMigrations(other, [core, explosivesMigration, blasting, operations]);
    prepared(db, 'SELECT count(*) AS n FROM site');
    expect(cacheSize(other)).toBe(0);
    expect(prepared(other, 'SELECT count(*) AS n FROM site')).not.toBe(
      prepared(db, 'SELECT count(*) AS n FROM site'),
    );
  });

  it('still runs the statement', () => {
    createSite(db, { code: 'MDW', name: 'Midway' }, { clock });
    expect(prepared(db, 'SELECT count(*) AS n FROM site').get().n).toBe(1);
  });

  it('can be emptied', () => {
    prepared(db, 'SELECT count(*) AS n FROM site');
    clearCache(db);
    expect(cacheSize(db)).toBe(0);
  });
});

describe('queries', () => {
  let siteId;
  let magazineId;

  beforeEach(() => {
    siteId = createSite(db, { code: 'MDW', name: 'Midway' }, { clock }).id;
    const productId = createProduct(
      db,
      { code: 'ANFO-80', name: 'Anfo', kind: 'bulk_anfo', densityKgM3: 800 },
      { clock },
    ).id;
    magazineId = createMagazine(
      db,
      { siteId, name: 'Upper store', netExplosiveLimitKg: 4000 },
      { clock },
    ).id;
    const batch = createBatch(db, { productId, batchCode: 'L1' }, { clock });
    recordMovement(
      db,
      { magazineId, batchId: batch.id, movement: 'receipt', quantity: 1000, massKg: 1000 },
      { clock },
    );
  });

  it('reads the ledger through the cache', () => {
    const read = queries(db);
    expect(read.ledgerFor(magazineId)).toHaveLength(1);
    expect(read.ledgerFor(magazineId)).toHaveLength(1);
    expect(cacheSize(db)).toBeGreaterThan(0);
  });

  it('counts a table', () => {
    expect(queries(db).countOf('site')).toBe(1);
  });

  it('reads the receptors of a site', () => {
    expect(queries(db).receptorsFor(siteId)).toEqual([]);
  });

  it('gives the same answers as the repository it caches for', () => {
    const cached = queries(db).ledgerFor(magazineId);
    const direct = ledgerFor(db, magazineId);
    expect(direct).toHaveLength(cached.length);
    expect(direct[0].productCode).toBe('ANFO-80');
  });

  it('reads a ledger filtered by date through the same cached statement', () => {
    expect(ledgerFor(db, magazineId, { from: '2026-01-01T00:00:00.000Z' })).toHaveLength(1);
    expect(ledgerFor(db, magazineId, { from: '2027-01-01T00:00:00.000Z' })).toHaveLength(0);
    expect(cacheSize(db)).toBeGreaterThan(0);
  });
});
