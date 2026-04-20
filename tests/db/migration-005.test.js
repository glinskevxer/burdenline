import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations, schemaVersion } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { migration as production } from '../../src/db/migrations/005_production.js';
import { migration as siteRules } from '../../src/db/migrations/006_site_rules.js';
import { migration as indexes } from '../../src/db/migrations/007_indexes.js';
import { insertRow, findById } from '../../src/db/repository.js';
import { ConflictError } from '../../src/lib/errors.js';

let db;
const NOW = '2026-01-16T09:00:00.000Z';

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
    reference: 'MDW-2026-001',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return 'blast_1';
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations, production, siteRules, indexes]);
});

afterEach(() => closeDatabase(db));

describe('the production tables', () => {
  it('takes the schema to 005', () => {
    expect(schemaVersion(db)).toBe('007');
  });

  it('creates them all', () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    for (const table of [
      'survey',
      'dig_record',
      'secondary_breaking',
      'supply_order',
      'supply_order_line',
      'drill_rig',
      'drill_shift',
    ]) {
      expect(names).toContain(table);
    }
  });
});

describe('surveys', () => {
  function survey(overrides = {}) {
    return {
      id: 'sur_1',
      blastId: 'blast_1',
      surveyedAt: NOW,
      method: 'laser_scan',
      volumeM3: 3900,
      createdAt: NOW,
      ...overrides,
    };
  }

  it('takes one against a shot', () => {
    seedBlast(seedSite());
    expect(() => insertRow(db, 'survey', survey())).not.toThrow();
  });

  it('takes a second one on a different day', () => {
    seedBlast(seedSite());
    insertRow(db, 'survey', survey());
    expect(() =>
      insertRow(db, 'survey', survey({ id: 'sur_2', surveyedAt: '2026-01-17T09:00:00.000Z' })),
    ).not.toThrow();
  });

  it('refuses the same survey twice', () => {
    seedBlast(seedSite());
    insertRow(db, 'survey', survey());
    expect(() => insertRow(db, 'survey', survey({ id: 'sur_2' }))).toThrow(ConflictError);
  });

  it('refuses a method nobody surveys with', () => {
    seedBlast(seedSite());
    expect(() => insertRow(db, 'survey', survey({ method: 'pacing' }))).toThrow(ConflictError);
  });

  it('refuses a volume of nothing', () => {
    seedBlast(seedSite());
    expect(() => insertRow(db, 'survey', survey({ volumeM3: 0 }))).toThrow(ConflictError);
  });
});

describe('dig records and secondary breaking', () => {
  it('takes a dig record with hours against it', () => {
    seedBlast(seedSite());
    expect(() =>
      insertRow(db, 'dig_record', {
        id: 'dig_1',
        blastId: 'blast_1',
        recordedOn: '2026-01-17',
        tonnes: 1400,
        hours: 8,
        createdAt: NOW,
      }),
    ).not.toThrow();
  });

  it('refuses a dig record with no hours', () => {
    seedBlast(seedSite());
    expect(() =>
      insertRow(db, 'dig_record', {
        id: 'dig_1',
        blastId: 'blast_1',
        recordedOn: '2026-01-17',
        tonnes: 1400,
        hours: 0,
        createdAt: NOW,
      }),
    ).toThrow(ConflictError);
  });

  it('refuses a breaking method nobody uses', () => {
    seedBlast(seedSite());
    expect(() =>
      insertRow(db, 'secondary_breaking', {
        id: 'brk_1',
        blastId: 'blast_1',
        carriedOutOn: '2026-01-17',
        method: 'sledgehammer',
        createdAt: NOW,
      }),
    ).toThrow(ConflictError);
  });
});

describe('orders', () => {
  it('starts an order placed and takes lines against it', () => {
    const siteId = seedSite();
    insertRow(db, 'product', {
      id: 'prod_1',
      code: 'ANFO-80',
      name: 'Anfo',
      kind: 'bulk_anfo',
      densityKgM3: 800,
      createdAt: NOW,
      updatedAt: NOW,
    });
    insertRow(db, 'supply_order', {
      id: 'ord_1',
      siteId,
      supplier: 'Kilcorney',
      reference: 'PO-1188',
      placedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(findById(db, 'supply_order', 'ord_1').state).toBe('placed');
    insertRow(db, 'supply_order_line', {
      id: 'line_1',
      orderId: 'ord_1',
      productId: 'prod_1',
      quantity: 2000,
      unit: 'kg',
      createdAt: NOW,
    });
    expect(findById(db, 'supply_order_line', 'line_1').deliveredQuantity).toBe(0);
  });

  it('keeps an order reference unique on a site', () => {
    const siteId = seedSite();
    const order = {
      id: 'ord_1',
      siteId,
      supplier: 'Kilcorney',
      reference: 'PO-1188',
      placedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    };
    insertRow(db, 'supply_order', order);
    expect(() => insertRow(db, 'supply_order', { ...order, id: 'ord_2' })).toThrow(ConflictError);
  });
});

describe('rigs and shifts', () => {
  function rig(overrides = {}) {
    return {
      id: 'rig_1',
      siteId: 'site_1',
      fleetNumber: 'DR-01',
      holeDiameterMinMm: 89,
      holeDiameterMaxMm: 115,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it('takes a rig with a diameter range', () => {
    seedSite();
    insertRow(db, 'drill_rig', rig());
    expect(findById(db, 'drill_rig', 'rig_1').status).toBe('available');
  });

  it('refuses a range that runs backwards', () => {
    seedSite();
    expect(() => insertRow(db, 'drill_rig', rig({ holeDiameterMaxMm: 50 }))).toThrow(ConflictError);
  });

  it('takes one shift per rig per shift per day', () => {
    seedSite();
    insertRow(db, 'drill_rig', rig());
    const shift = {
      id: 'shift_1',
      rigId: 'rig_1',
      shiftDate: '2026-01-16',
      shift: 'day',
      metresDrilled: 220,
      holesDrilled: 14,
      hours: 8,
      createdAt: NOW,
    };
    insertRow(db, 'drill_shift', shift);
    expect(() => insertRow(db, 'drill_shift', { ...shift, id: 'shift_2' })).toThrow(ConflictError);
    expect(() =>
      insertRow(db, 'drill_shift', { ...shift, id: 'shift_2', shift: 'night' }),
    ).not.toThrow();
  });

  it('refuses a shift nobody works', () => {
    seedSite();
    insertRow(db, 'drill_rig', rig());
    expect(() =>
      insertRow(db, 'drill_shift', {
        id: 'shift_1',
        rigId: 'rig_1',
        shiftDate: '2026-01-16',
        shift: 'twilight',
        hours: 8,
        createdAt: NOW,
      }),
    ).toThrow(ConflictError);
  });
});
