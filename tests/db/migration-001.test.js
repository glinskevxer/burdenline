import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';

let db;

const NOW = '2025-02-03T09:00:00.000Z';

function insert(table, row) {
  const full = { ...row, created_at: NOW, updated_at: NOW };
  const columns = Object.keys(full);
  const statement = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns
    .map((column) => `@${column}`)
    .join(', ')})`;
  db.prepare(statement).run(full);
  return full.id;
}

function insertSite(overrides = {}) {
  return insert('site', {
    id: 'site_1',
    code: 'MDW',
    name: 'Midway',
    time_zone: 'Europe/Dublin',
    ...overrides,
  });
}

function insertBench(siteId, overrides = {}) {
  return insert('bench', {
    id: 'bench_1',
    site_id: siteId,
    name: 'North 60',
    crest_level_m: 84,
    toe_level_m: 69,
    rock_type: 'dolerite',
    rock_density_kg_m3: 2900,
    ...overrides,
  });
}

function insertPattern(benchId, overrides = {}) {
  return insert('pattern', {
    id: 'pat_1',
    bench_id: benchId,
    reference: 'MDW-2025-001',
    hole_diameter_mm: 102,
    nominal_burden_m: 3,
    nominal_spacing_m: 3.5,
    row_count: 3,
    holes_per_row: 8,
    bench_height_m: 15,
    ...overrides,
  });
}

function insertHole(patternId, overrides = {}) {
  return insert('hole', {
    id: 'hole_1',
    pattern_id: patternId,
    hole_number: 1,
    row_number: 1,
    easting_m: 1000,
    northing_m: 2000,
    collar_level_m: 84,
    designed_depth_m: 16,
    diameter_mm: 102,
    ...overrides,
  });
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core]);
});

afterEach(() => closeDatabase(db));

describe('the core tables', () => {
  it('creates all four', () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(names).toContain('site');
    expect(names).toContain('bench');
    expect(names).toContain('pattern');
    expect(names).toContain('hole');
  });

  it('indexes the lookups the app actually makes', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['bench_by_site', 'pattern_by_bench', 'hole_by_pattern']),
    );
  });
});

describe('site constraints', () => {
  it('takes a well formed site', () => {
    expect(() => insertSite()).not.toThrow();
  });

  it('refuses a lowercase code', () => {
    expect(() => insertSite({ code: 'mdw' })).toThrow(/CHECK/);
  });

  it('refuses a code that is too long to fit a shot reference', () => {
    expect(() => insertSite({ code: 'MIDWAY' })).toThrow(/CHECK/);
  });

  it('keeps codes unique', () => {
    insertSite();
    expect(() => insertSite({ id: 'site_2' })).toThrow(/UNIQUE/);
  });
});

describe('bench constraints', () => {
  it('refuses a bench whose crest is below its toe', () => {
    const siteId = insertSite();
    expect(() => insertBench(siteId, { crest_level_m: 60, toe_level_m: 69 })).toThrow(/CHECK/);
  });

  it('refuses a rock density outside anything that comes out of a quarry', () => {
    const siteId = insertSite();
    expect(() => insertBench(siteId, { rock_density_kg_m3: 900 })).toThrow(/CHECK/);
  });

  it('refuses a bench on a site that is not there', () => {
    expect(() => insertBench('site_missing')).toThrow(/FOREIGN KEY/);
  });

  it('takes benches away with the site', () => {
    const siteId = insertSite();
    insertBench(siteId);
    db.prepare('DELETE FROM site WHERE id = ?').run(siteId);
    expect(db.prepare('SELECT count(*) AS n FROM bench').get().n).toBe(0);
  });
});

describe('pattern constraints', () => {
  it('refuses a layout nobody drills', () => {
    const patternId = () => insertPattern(insertBench(insertSite()), { layout: 'spiral' });
    expect(patternId).toThrow(/CHECK/);
  });

  it('refuses an inclination past the point a rig can drill', () => {
    expect(() => insertPattern(insertBench(insertSite()), { inclination_deg: 60 })).toThrow(
      /CHECK/,
    );
  });

  it('refuses a bearing at or past a full circle', () => {
    expect(() => insertPattern(insertBench(insertSite()), { bearing_deg: 360 })).toThrow(/CHECK/);
  });

  it('keeps the reference unique across the site', () => {
    const benchId = insertBench(insertSite());
    insertPattern(benchId);
    expect(() => insertPattern(benchId, { id: 'pat_2' })).toThrow(/UNIQUE/);
  });
});

describe('hole constraints', () => {
  function pattern() {
    return insertPattern(insertBench(insertSite()));
  }

  it('numbers holes uniquely inside a pattern', () => {
    const patternId = pattern();
    insertHole(patternId);
    expect(() => insertHole(patternId, { id: 'hole_2' })).toThrow(/UNIQUE/);
    expect(() => insertHole(patternId, { id: 'hole_2', hole_number: 2 })).not.toThrow();
  });

  it('refuses a condition that is not one the driller records', () => {
    expect(() => insertHole(pattern(), { condition: 'soggy' })).toThrow(/CHECK/);
  });

  it('defaults a fresh hole to planned and dry', () => {
    const patternId = pattern();
    insertHole(patternId);
    const row = db.prepare('SELECT status, condition FROM hole').get();
    expect(row).toEqual({ status: 'planned', condition: 'dry' });
  });

  it('leaves the drilled depth unset until the rig reports', () => {
    insertHole(pattern());
    expect(db.prepare('SELECT drilled_depth_m FROM hole').get().drilled_depth_m).toBe(null);
  });
});
