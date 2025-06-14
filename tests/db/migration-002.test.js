import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { insertRow } from '../../src/db/repository.js';
import { ConflictError } from '../../src/lib/errors.js';

let db;
const NOW = '2025-06-16T09:00:00.000Z';

function seedSite() {
  insertRow(db, 'site', {
    id: 'site_1',
    code: 'MDW',
    name: 'Midway',
    timeZone: 'Europe/Dublin',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return 'site_1';
}

function seedProduct(overrides = {}) {
  insertRow(db, 'product', {
    id: 'prod_1',
    code: 'ANFO-80',
    name: 'Ammonium nitrate fuel oil',
    kind: 'bulk_anfo',
    densityKgM3: 800,
    unNumber: 'UN0331',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  return overrides.id ?? 'prod_1';
}

function seedMagazine(siteId, overrides = {}) {
  insertRow(db, 'magazine', {
    id: 'mag_1',
    siteId,
    name: 'Upper store',
    netExplosiveLimitKg: 2000,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  return overrides.id ?? 'mag_1';
}

function seedBatch(productId, overrides = {}) {
  insertRow(db, 'product_batch', {
    id: 'batch_1',
    productId,
    batchCode: 'L2025-114',
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  return overrides.id ?? 'batch_1';
}

function seedLedger(magazineId, batchId, overrides = {}) {
  insertRow(db, 'magazine_ledger', {
    id: 'led_1',
    magazineId,
    batchId,
    movement: 'receipt',
    quantity: 1000,
    unit: 'kg',
    massKg: 1000,
    occurredAt: NOW,
    recordedAt: NOW,
    createdAt: NOW,
    ...overrides,
  });
  return overrides.id ?? 'led_1';
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives]);
});

afterEach(() => closeDatabase(db));

describe('the explosives tables', () => {
  it('creates all five', () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    for (const table of [
      'product',
      'magazine',
      'product_batch',
      'magazine_ledger',
      'daybook_entry',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('indexes the ledger the three ways it is read', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['ledger_by_magazine', 'ledger_by_batch', 'ledger_by_blast']),
    );
  });
});

describe('product constraints', () => {
  it('takes a well formed product', () => {
    expect(() => seedProduct()).not.toThrow();
  });

  it('refuses a kind that is not in the catalogue vocabulary', () => {
    expect(() => seedProduct({ kind: 'dynamite' })).toThrow(ConflictError);
    try {
      seedProduct({ kind: 'dynamite' });
    } catch (error) {
      expect(error.details.constraint).toContain('kind IN');
    }
  });

  it('refuses a UN number in the wrong shape', () => {
    expect(() => seedProduct({ unNumber: '0331' })).toThrow(ConflictError);
  });

  it('refuses a density outside anything a product has', () => {
    expect(() => seedProduct({ densityKgM3: 50 })).toThrow(ConflictError);
  });

  it('keeps product codes unique', () => {
    seedProduct();
    expect(() => seedProduct({ id: 'prod_2' })).toThrow(ConflictError);
  });
});

describe('magazine constraints', () => {
  it('requires a net explosive limit above zero', () => {
    const siteId = seedSite();
    expect(() => seedMagazine(siteId, { netExplosiveLimitKg: 0 })).toThrow(ConflictError);
  });

  it('refuses a kind of store nobody licenses', () => {
    const siteId = seedSite();
    expect(() => seedMagazine(siteId, { kind: 'shed' })).toThrow(ConflictError);
  });

  it('keeps magazine names unique on a site', () => {
    const siteId = seedSite();
    seedMagazine(siteId);
    expect(() => seedMagazine(siteId, { id: 'mag_2' })).toThrow(ConflictError);
  });
});

describe('batch constraints', () => {
  it('keeps a batch code unique for a product', () => {
    const productId = seedProduct();
    seedBatch(productId);
    expect(() => seedBatch(productId, { id: 'batch_2' })).toThrow(ConflictError);
  });

  it('lets the same batch code exist for a different product', () => {
    const first = seedProduct();
    const second = seedProduct({ id: 'prod_2', code: 'EM-115', kind: 'bulk_emulsion' });
    seedBatch(first);
    expect(() => seedBatch(second, { id: 'batch_2' })).not.toThrow();
  });

  it('refuses an expiry before the manufacture date', () => {
    const productId = seedProduct();
    expect(() =>
      seedBatch(productId, { manufacturedOn: '2025-01-01', expiresOn: '2024-06-01' }),
    ).toThrow(ConflictError);
  });

  it('will not let a product with stock be deleted', () => {
    const productId = seedProduct();
    seedBatch(productId);
    expect(() => db.prepare('DELETE FROM product WHERE id = ?').run(productId)).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe('ledger constraints', () => {
  function seeded() {
    const siteId = seedSite();
    const productId = seedProduct();
    return { magazineId: seedMagazine(siteId), batchId: seedBatch(productId) };
  }

  it('takes a receipt', () => {
    const { magazineId, batchId } = seeded();
    expect(() => seedLedger(magazineId, batchId)).not.toThrow();
  });

  it('refuses a movement that is not in the vocabulary', () => {
    const { magazineId, batchId } = seeded();
    expect(() => seedLedger(magazineId, batchId, { movement: 'borrowed' })).toThrow(ConflictError);
  });

  it('refuses a line that moves nothing', () => {
    const { magazineId, batchId } = seeded();
    expect(() => seedLedger(magazineId, batchId, { quantity: 0 })).toThrow(ConflictError);
  });

  it('takes a negative quantity, which is how an issue is written', () => {
    const { magazineId, batchId } = seeded();
    expect(() =>
      seedLedger(magazineId, batchId, { movement: 'issue', quantity: -250, massKg: -250 }),
    ).not.toThrow();
  });

  it('lets a correction point at the line it corrects', () => {
    const { magazineId, batchId } = seeded();
    seedLedger(magazineId, batchId);
    expect(() =>
      seedLedger(magazineId, batchId, {
        id: 'led_2',
        movement: 'correction',
        quantity: -20,
        massKg: -20,
        correctsId: 'led_1',
        reason: 'weighbridge ticket read wrong',
      }),
    ).not.toThrow();
  });

  it('will not let a magazine with ledger lines be deleted', () => {
    const { magazineId, batchId } = seeded();
    seedLedger(magazineId, batchId);
    expect(() => db.prepare('DELETE FROM magazine WHERE id = ?').run(magazineId)).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe('daybook constraints', () => {
  it('numbers entries uniquely within a day', () => {
    const siteId = seedSite();
    const entry = {
      id: 'day_1',
      siteId,
      entryDate: '2025-06-16',
      sequence: 1,
      movement: 'issue',
      productCode: 'ANFO-80',
      quantity: 250,
      unit: 'kg',
      balanceAfter: 750,
      personName: 'M Cronin',
      createdAt: NOW,
    };
    insertRow(db, 'daybook_entry', entry);
    expect(() => insertRow(db, 'daybook_entry', { ...entry, id: 'day_2' })).toThrow(ConflictError);
    expect(() =>
      insertRow(db, 'daybook_entry', { ...entry, id: 'day_2', sequence: 2 }),
    ).not.toThrow();
  });

  it('starts the sequence at one', () => {
    const siteId = seedSite();
    expect(() =>
      insertRow(db, 'daybook_entry', {
        id: 'day_1',
        siteId,
        entryDate: '2025-06-16',
        sequence: 0,
        movement: 'issue',
        productCode: 'ANFO-80',
        quantity: 250,
        unit: 'kg',
        balanceAfter: 750,
        personName: 'M Cronin',
        createdAt: NOW,
      }),
    ).toThrow(ConflictError);
  });
});
