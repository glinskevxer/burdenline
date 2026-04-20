import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase, seedPerson } from '../helpers/database.js';
import { schemaVersion } from '../../src/db/migrate.js';
import { createSite } from '../../src/db/repositories/sites.js';
import {
  createProduct,
  createMagazine,
  createBatch,
  recordMovement,
  balanceRows,
} from '../../src/db/repositories/explosives.js';
import { fixedClock } from '../../src/lib/clock.js';

let db;
const clock = fixedClock('2026-04-24T09:00:00Z');

function plan(sql, parameters = {}) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(parameters)
    .map((row) => row.detail)
    .join(' | ');
}

beforeEach(async () => {
  db = await openTestDatabase();
});

afterEach(() => closeTestDatabase(db));

describe('the indexes', () => {
  it('takes the schema to 007', () => {
    expect(schemaVersion(db)).toBe('007');
  });

  it('creates every one of them', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    for (const index of [
      'ledger_stock',
      'deck_by_hole',
      'record_by_receptor',
      'blast_by_site_fired',
      'blast_by_planned',
      'order_line_by_product',
      'rules_current',
    ]) {
      expect(indexes).toContain(index);
    }
  });
});

describe('the plans they were added for', () => {
  it('reads the ledger stock check off an index rather than scanning', () => {
    const detail = plan(
      `SELECT batch_id, sum(quantity) FROM magazine_ledger
       WHERE magazine_id = @magazineId AND movement <> 'consumption' GROUP BY batch_id`,
      { magazineId: 'mag_1' },
    );
    expect(detail).toContain('USING INDEX');
    expect(detail).not.toContain('SCAN magazine_ledger');
  });

  it('reads a shot decks off an index', () => {
    const detail = plan('SELECT * FROM charge_deck WHERE hole_id = @holeId ORDER BY deck_number', {
      holeId: 'hole_1',
    });
    expect(detail).toContain('deck_by_hole');
    expect(detail).not.toContain('SCAN charge_deck');
  });

  it('reads the rules in force off the partial index', () => {
    const detail = plan(
      `SELECT * FROM site_rules WHERE site_id = @siteId AND rule_set = @ruleSet AND superseded_at IS NULL`,
      { siteId: 'site_1', ruleSet: 'charge' },
    );
    expect(detail).toContain('USING INDEX');
    expect(detail).not.toContain('SCAN site_rules');
  });

  it('finds the shots planned inside a window off the partial index', () => {
    const detail = plan('SELECT * FROM blast WHERE planned_for >= @from AND planned_for <= @to', {
      from: 'a',
      to: 'b',
    });
    expect(detail).toContain('blast_by_planned');
  });
});

describe('the stock check still gives the same answer', () => {
  it('sums the batches the same way the domain does', () => {
    seedPerson(db);
    const siteId = createSite(db, { code: 'MDW', name: 'Midway' }, { clock }).id;
    const productId = createProduct(
      db,
      { code: 'ANFO-80', name: 'Anfo', kind: 'bulk_anfo', densityKgM3: 800 },
      { clock },
    ).id;
    const magazineId = createMagazine(
      db,
      { siteId, name: 'Upper store', netExplosiveLimitKg: 8000 },
      { clock },
    ).id;
    const batch = createBatch(db, { productId, batchCode: 'L1' }, { clock });
    recordMovement(
      db,
      { magazineId, batchId: batch.id, movement: 'receipt', quantity: 1000, massKg: 1000 },
      { clock },
    );
    recordMovement(
      db,
      { magazineId, batchId: batch.id, movement: 'issue', quantity: 250, massKg: 250 },
      { clock },
    );
    const rows = balanceRows(db, magazineId);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(750);
  });
});
