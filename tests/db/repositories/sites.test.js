import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { migration as core } from '../../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../../src/db/migrations/003_blasting.js';
import {
  createSite,
  findSite,
  getSite,
  findSiteByCode,
  listSites,
  updateSite,
  createBench,
  getBench,
  listBenches,
  updateBench,
  benchHeightM,
  retireBench,
  deleteSite,
} from '../../../src/db/repositories/sites.js';
import { fixedClock } from '../../../src/lib/clock.js';
import { NotFoundError, ConflictError } from '../../../src/lib/errors.js';
import { insertRow } from '../../../src/db/repository.js';

let db;
const clock = fixedClock('2025-08-05T09:00:00Z');
const context = { clock };

function site(overrides = {}) {
  return createSite(
    db,
    { code: 'MDW', name: 'Midway', timeZone: 'Europe/Dublin', ...overrides },
    context,
  );
}

function bench(siteId, overrides = {}) {
  return createBench(
    db,
    {
      siteId,
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
      ...overrides,
    },
    context,
  );
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting]);
});

afterEach(() => closeDatabase(db));

describe('sites', () => {
  it('creates one with an id and timestamps of its own', () => {
    const created = site();
    expect(created.id.startsWith('site_')).toBe(true);
    expect(created.createdAt).toBe('2025-08-05T09:00:00.000Z');
    expect(created.updatedAt).toBe(created.createdAt);
  });

  it('takes an id the caller supplies', () => {
    expect(site({ id: 'site_fixed' }).id).toBe('site_fixed');
  });

  it('reads one back', () => {
    const created = site();
    expect(getSite(db, created.id).name).toBe('Midway');
    expect(findSite(db, 'site_missing')).toBe(null);
  });

  it('throws for a site that is not there', () => {
    expect(() => getSite(db, 'site_missing')).toThrow(NotFoundError);
  });

  it('finds one by its code', () => {
    site();
    expect(findSiteByCode(db, 'MDW').name).toBe('Midway');
    expect(findSiteByCode(db, 'XXX')).toBe(null);
  });

  it('refuses two sites with the same code', () => {
    site();
    expect(() => site({ name: 'Midway lower' })).toThrow(ConflictError);
  });

  it('lists them in code order', () => {
    site({ code: 'RCK', name: 'Rockfield' });
    site();
    expect(listSites(db).map((row) => row.code)).toEqual(['MDW', 'RCK']);
  });

  it('updates only the fields it is allowed to', () => {
    const created = site();
    const updated = updateSite(db, created.id, { name: 'Midway Quarry', code: 'ZZZ' }, context);
    expect(updated.name).toBe('Midway Quarry');
    expect(updated.code).toBe('MDW');
  });

  it('will not update a site that is not there', () => {
    expect(() => updateSite(db, 'site_missing', { name: 'x' }, context)).toThrow(NotFoundError);
  });
});

describe('benches', () => {
  it('creates one against a site', () => {
    const created = bench(site().id);
    expect(created.id.startsWith('bench_')).toBe(true);
    expect(created.status).toBe('active');
  });

  it('refuses a bench on a site that is not there', () => {
    expect(() => bench('site_missing')).toThrow(NotFoundError);
  });

  it('lists the benches of a site', () => {
    const siteId = site().id;
    bench(siteId);
    bench(siteId, { name: 'East 45' });
    expect(listBenches(db, siteId).map((row) => row.name)).toEqual(['East 45', 'North 60']);
  });

  it('filters the list by status', () => {
    const siteId = site().id;
    const first = bench(siteId);
    bench(siteId, { name: 'East 45' });
    retireBench(db, first.id, context);
    expect(listBenches(db, siteId, { status: 'active' })).toHaveLength(1);
  });

  it('refuses two benches with the same name on one site', () => {
    const siteId = site().id;
    bench(siteId);
    expect(() => bench(siteId)).toThrow(ConflictError);
  });

  it('allows the same bench name on a different site', () => {
    bench(site().id);
    expect(() => bench(site({ code: 'RCK', name: 'Rockfield' }).id)).not.toThrow();
  });

  it('works the bench height out from the levels', () => {
    expect(benchHeightM(bench(site().id))).toBe(15);
  });

  it('reads a bench back by id', () => {
    const created = bench(site().id);
    expect(getBench(db, created.id).name).toBe('North 60');
    expect(() => getBench(db, 'bench_missing')).toThrow(NotFoundError);
  });

  it('updates a bench and moves its timestamp', () => {
    const created = bench(site().id);
    const later = { clock: fixedClock('2025-09-01T09:00:00Z') };
    const updated = updateBench(db, created.id, { rockType: 'limestone' }, later);
    expect(updated.rockType).toBe('limestone');
    expect(updated.updatedAt).toBe('2025-09-01T09:00:00.000Z');
  });

  it('retires a bench once and then refuses', () => {
    const created = bench(site().id);
    expect(retireBench(db, created.id, context).status).toBe('worked_out');
    expect(() => retireBench(db, created.id, context)).toThrow(ConflictError);
  });

  it('refuses a bench whose crest is under its toe', () => {
    expect(() => bench(site().id, { crestLevelM: 60 })).toThrow(ConflictError);
  });
});

describe('deleteSite', () => {
  it('removes a site nothing was recorded against', () => {
    const created = site();
    expect(deleteSite(db, created.id)).toBe(1);
    expect(findSite(db, created.id)).toBe(null);
  });

  it('takes the benches with it', () => {
    const created = site();
    bench(created.id);
    deleteSite(db, created.id);
    expect(listBenches(db, created.id)).toEqual([]);
  });

  it('refuses to remove a site with a shot on it', () => {
    const created = site();
    insertRow(db, 'blast', {
      id: 'blast_1',
      siteId: created.id,
      reference: 'MDW-2025-001',
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    expect(() => deleteSite(db, created.id)).toThrow(/shots recorded/);
  });

  it('refuses a site that is not there', () => {
    expect(() => deleteSite(db, 'site_missing')).toThrow(NotFoundError);
  });
});
