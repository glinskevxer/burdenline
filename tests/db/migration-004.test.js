import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations, schemaVersion } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { insertRow, findById } from '../../src/db/repository.js';
import { ConflictError } from '../../src/lib/errors.js';

let db;
const NOW = '2025-11-18T09:00:00.000Z';

function seedSite() {
  insertRow(db, 'site', {
    id: 'site_1',
    code: 'MDW',
    name: 'Midway',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return 'site_1';
}

function seedBlast(siteId) {
  insertRow(db, 'blast', {
    id: 'blast_1',
    siteId,
    reference: 'MDW-2025-014',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return 'blast_1';
}

function inspection(overrides = {}) {
  return {
    id: 'insp_1',
    blastId: 'blast_1',
    inspectedAt: NOW,
    muckpileShape: 'moderate',
    throwM: 12,
    toeGrade: 'none',
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations]);
});

afterEach(() => closeDatabase(db));

describe('the operations tables', () => {
  it('takes the schema to 004', () => {
    expect(schemaVersion(db)).toBe('004');
  });

  it('creates them all', () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    for (const table of [
      'product_price',
      'cost_rate',
      'blast_inspection',
      'misfire',
      'complaint',
      'notification',
      'audit_entry',
    ]) {
      expect(names).toContain(table);
    }
  });
});

describe('inspections', () => {
  it('allows one per shot and no more', () => {
    seedBlast(seedSite());
    insertRow(db, 'blast_inspection', inspection());
    expect(() => insertRow(db, 'blast_inspection', inspection({ id: 'insp_2' }))).toThrow(
      ConflictError,
    );
  });

  it('refuses a muckpile shape nobody records', () => {
    seedBlast(seedSite());
    expect(() => insertRow(db, 'blast_inspection', inspection({ muckpileShape: 'flat' }))).toThrow(
      ConflictError,
    );
  });

  it('refuses a fume grade off the scale', () => {
    seedBlast(seedSite());
    expect(() => insertRow(db, 'blast_inspection', inspection({ fumeGrade: 9 }))).toThrow(
      ConflictError,
    );
  });

  it('goes away with the shot', () => {
    const blastId = seedBlast(seedSite());
    insertRow(db, 'blast_inspection', inspection());
    db.prepare('DELETE FROM blast WHERE id = ?').run(blastId);
    expect(db.prepare('SELECT count(*) AS n FROM blast_inspection').get().n).toBe(0);
  });
});

describe('complaints', () => {
  function complaint(overrides = {}) {
    return {
      id: 'cmp_1',
      siteId: 'site_1',
      receivedAt: NOW,
      channel: 'telephone',
      about: 'vibration',
      description: 'the pictures came off the wall again',
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it('takes one and starts it open', () => {
    seedSite();
    insertRow(db, 'complaint', complaint());
    expect(findById(db, 'complaint', 'cmp_1').state).toBe('open');
  });

  it('refuses a channel nobody uses', () => {
    seedSite();
    expect(() => insertRow(db, 'complaint', complaint({ channel: 'carrier_pigeon' }))).toThrow(
      ConflictError,
    );
  });

  it('refuses a subject that is not one of the listed ones', () => {
    seedSite();
    expect(() => insertRow(db, 'complaint', complaint({ about: 'the weather' }))).toThrow(
      ConflictError,
    );
  });

  it('keeps the complaint when the shot it named is deleted', () => {
    const siteId = seedSite();
    const blastId = seedBlast(siteId);
    insertRow(db, 'complaint', complaint({ blastId }));
    db.prepare('DELETE FROM blast WHERE id = ?').run(blastId);
    expect(findById(db, 'complaint', 'cmp_1').blastId).toBe(null);
  });
});

describe('notifications', () => {
  it('starts planned and takes a sent time later', () => {
    const blastId = seedBlast(seedSite());
    insertRow(db, 'notification', {
      id: 'ntf_1',
      blastId,
      channel: 'text_message',
      addressedTo: 'Keeper cottage',
      plannedFor: NOW,
      createdAt: NOW,
    });
    expect(findById(db, 'notification', 'ntf_1').state).toBe('planned');
  });

  it('refuses a state nobody defined', () => {
    const blastId = seedBlast(seedSite());
    expect(() =>
      insertRow(db, 'notification', {
        id: 'ntf_1',
        blastId,
        channel: 'email',
        addressedTo: 'x',
        plannedFor: NOW,
        state: 'maybe',
        createdAt: NOW,
      }),
    ).toThrow(ConflictError);
  });
});

describe('prices and rates', () => {
  it('refuses a price that ends before it starts', () => {
    insertRow(db, 'product', {
      id: 'prod_1',
      code: 'ANFO-80',
      name: 'Anfo',
      kind: 'bulk_anfo',
      densityKgM3: 800,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(() =>
      insertRow(db, 'product_price', {
        id: 'price_1',
        productId: 'prod_1',
        unit: 'kg',
        pricePerUnit: 1.2,
        effectiveFrom: '2025-01-01',
        effectiveTo: '2024-01-01',
        createdAt: NOW,
      }),
    ).toThrow(ConflictError);
  });

  it('refuses a cost kind nobody accounts for', () => {
    const siteId = seedSite();
    expect(() =>
      insertRow(db, 'cost_rate', {
        id: 'rate_1',
        siteId,
        kind: 'catering',
        rate: 40,
        unit: 'hour',
        effectiveFrom: '2025-01-01',
        createdAt: NOW,
      }),
    ).toThrow(ConflictError);
  });
});

describe('the audit table', () => {
  it('takes an entry with the before and after on it', () => {
    insertRow(db, 'audit_entry', {
      id: 'aud_1',
      occurredAt: NOW,
      actorId: 'per_1',
      action: 'receptor.update',
      entityKind: 'receptor',
      entityId: 'rec_1',
      beforeJson: JSON.stringify({ limitMmPerSecond: null }),
      afterJson: JSON.stringify({ limitMmPerSecond: 6 }),
      requestId: 'req_1',
      createdAt: NOW,
    });
    const entry = findById(db, 'audit_entry', 'aud_1');
    expect(JSON.parse(entry.afterJson).limitMmPerSecond).toBe(6);
  });

  it('survives the record it describes being deleted', () => {
    insertRow(db, 'audit_entry', {
      id: 'aud_1',
      occurredAt: NOW,
      action: 'receptor.delete',
      entityKind: 'receptor',
      entityId: 'rec_1',
      createdAt: NOW,
    });
    expect(findById(db, 'audit_entry', 'aud_1').entityId).toBe('rec_1');
  });
});
