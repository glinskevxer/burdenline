import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { migration as core } from '../../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../../src/db/migrations/004_operations.js';
import { createSite } from '../../../src/db/repositories/sites.js';
import { createBlast } from '../../../src/db/repositories/blasts.js';
import {
  createReceptor,
  getReceptor,
  listReceptors,
  updateReceptor,
  importRecords,
  listRecords,
  attachRecordToBlast,
  saveSiteLaw,
  currentSiteLaw,
  siteLawHistory,
} from '../../../src/db/repositories/monitoring.js';
import { parseRecord } from '../../../src/domain/monitoring/records.js';
import { fixedClock } from '../../../src/lib/clock.js';
import { NotFoundError, ConflictError } from '../../../src/lib/errors.js';

let db;
let siteId;
const clock = fixedClock('2025-08-15T09:00:00Z');
const context = { clock };

function receptor(overrides = {}) {
  return createReceptor(
    db,
    {
      siteId,
      name: 'Keeper cottage',
      structureClass: 'older_dwelling',
      easting: 1200,
      northing: 2000,
      monitored: true,
      ...overrides,
    },
    context,
  );
}

function record(overrides = {}) {
  return parseRecord({
    monitorSerial: 'BE-11482',
    triggeredAt: '2025-08-15T13:04:11.000Z',
    distanceM: 412,
    longitudinal: { peakMmPerSecond: 2.4, frequencyHz: 18 },
    transverse: { peakMmPerSecond: 3.1, frequencyHz: 14 },
    vertical: { peakMmPerSecond: 1.9, frequencyHz: 26 },
    airblastDb: 112.4,
    ...overrides,
  });
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations]);
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, context).id;
});

afterEach(() => closeDatabase(db));

describe('receptors', () => {
  it('creates one and reads it back in the shape the domain wants', () => {
    const created = receptor();
    expect(created.id.startsWith('rec_')).toBe(true);
    const [read] = listReceptors(db, siteId);
    expect(read.easting).toBe(1200);
    expect(read.monitored).toBe(true);
    expect(read.occupied).toBe(true);
  });

  it('refuses a receptor on a site that is not there', () => {
    expect(() => receptor({ siteId: 'site_missing' })).toThrow(NotFoundError);
  });

  it('refuses two receptors with the same name on a site', () => {
    receptor();
    expect(() => receptor()).toThrow(ConflictError);
  });

  it('filters to the monitored ones', () => {
    receptor();
    receptor({ name: 'Council depot', monitored: false });
    expect(listReceptors(db, siteId, { monitoredOnly: true })).toHaveLength(1);
  });

  it('updates the fields that are allowed to change', () => {
    const created = receptor();
    const updated = updateReceptor(
      db,
      created.id,
      { limitMmPerSecond: 6, occupied: false },
      context,
    );
    expect(updated.limitMmPerSecond).toBe(6);
    expect(updated.occupied).toBe(0);
  });

  it('refuses to update one that is not there', () => {
    expect(() => updateReceptor(db, 'rec_missing', { note: 'x' }, context)).toThrow(NotFoundError);
    expect(() => getReceptor(db, 'rec_missing')).toThrow(NotFoundError);
  });
});

describe('importRecords', () => {
  it('writes a batch', () => {
    const result = importRecords(db, siteId, [record()], { clock, sourceFile: 'be11482.csv' });
    expect(result.inserted).toBe(1);
    expect(listRecords(db, siteId)[0].sourceFile).toBe('be11482.csv');
  });

  it('keeps the peak and the components apart', () => {
    importRecords(db, siteId, [record()], { clock });
    const [stored] = listRecords(db, siteId);
    expect(stored.peakMmPerSecond).toBe(3.1);
    expect(stored.peakComponent).toBe('transverse');
    expect(stored.verticalMmPerSecond).toBe(1.9);
  });

  it('counts a repeated file as duplicates rather than writing it twice', () => {
    importRecords(db, siteId, [record()], { clock });
    const second = importRecords(db, siteId, [record()], { clock });
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(listRecords(db, siteId)).toHaveLength(1);
  });

  it('takes the new records out of a partly repeated file', () => {
    importRecords(db, siteId, [record()], { clock });
    const second = importRecords(
      db,
      siteId,
      [record(), record({ triggeredAt: '2025-08-16T13:04:11.000Z' })],
      { clock },
    );
    expect(second.inserted).toBe(1);
    expect(second.duplicates).toBe(1);
  });

  it('filters by date and by receptor', () => {
    const first = receptor();
    importRecords(db, siteId, [record({ receptorId: first.id })], { clock });
    importRecords(db, siteId, [record({ triggeredAt: '2025-09-01T10:00:00.000Z' })], { clock });
    expect(listRecords(db, siteId, { from: '2025-08-20T00:00:00.000Z' })).toHaveLength(1);
    expect(listRecords(db, siteId, { receptorId: first.id })).toHaveLength(1);
  });

  it('refuses an import against a site that is not there', () => {
    expect(() => importRecords(db, 'site_missing', [record()], { clock })).toThrow(NotFoundError);
  });
});

describe('attachRecordToBlast', () => {
  it('attaches a record to the shot it heard', () => {
    const blast = createBlast(db, { siteId, reference: 'MDW-2025-014' }, context);
    const { ids } = importRecords(db, siteId, [record()], { clock });
    const attached = attachRecordToBlast(db, ids[0], blast.id);
    expect(attached.blastId).toBe(blast.id);
    expect(listRecords(db, siteId, { blastId: blast.id })).toHaveLength(1);
  });

  it('refuses to move a record to a second shot', () => {
    const first = createBlast(db, { siteId, reference: 'MDW-2025-014' }, context);
    const second = createBlast(db, { siteId, reference: 'MDW-2025-015' }, context);
    const { ids } = importRecords(db, siteId, [record()], { clock });
    attachRecordToBlast(db, ids[0], first.id);
    expect(() => attachRecordToBlast(db, ids[0], second.id)).toThrow(/already attached/);
  });

  it('refuses a record that is not there', () => {
    expect(() => attachRecordToBlast(db, 'mon_missing', 'blast_1')).toThrow(ConflictError);
  });
});

describe('site laws', () => {
  it('stores a fit and reads it back as current', () => {
    saveSiteLaw(db, { siteId, k: 1140, b: 1.6, recordCount: 22, rSquared: 0.91 }, context);
    const law = currentSiteLaw(db, siteId);
    expect(law.k).toBe(1140);
    expect(law.supersededAt).toBe(null);
  });

  it('supersedes the previous fit rather than editing it', () => {
    saveSiteLaw(db, { siteId, k: 1140, b: 1.6, recordCount: 22 }, context);
    saveSiteLaw(db, { siteId, k: 980, b: 1.55, recordCount: 30 }, context);
    expect(currentSiteLaw(db, siteId).k).toBe(980);
    expect(siteLawHistory(db, siteId)).toHaveLength(2);
    expect(siteLawHistory(db, siteId).filter((law) => law.supersededAt !== null)).toHaveLength(1);
  });

  it('keeps a receptor law separate from the site law', () => {
    const cottage = receptor();
    saveSiteLaw(db, { siteId, k: 1140, b: 1.6, recordCount: 22 }, context);
    saveSiteLaw(db, { siteId, receptorId: cottage.id, k: 800, b: 1.5, recordCount: 12 }, context);
    expect(currentSiteLaw(db, siteId).k).toBe(1140);
    expect(currentSiteLaw(db, siteId, cottage.id).k).toBe(800);
  });

  it('falls back to the site law when a receptor has none of its own', () => {
    const cottage = receptor();
    saveSiteLaw(db, { siteId, k: 1140, b: 1.6, recordCount: 22 }, context);
    expect(currentSiteLaw(db, siteId, cottage.id).k).toBe(1140);
  });

  it('has no law at all for a site nothing has been fitted for', () => {
    expect(currentSiteLaw(db, siteId)).toBe(null);
  });
});
