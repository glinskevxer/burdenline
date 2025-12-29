import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosivesMigration } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { runJob } from '../../src/jobs/framework.js';
import { stockSweepJob, sleepingHolesJob } from '../../src/jobs/stock-sweep.js';
import { createSite, createBench } from '../../src/db/repositories/sites.js';
import { createPattern, replaceHoles, listHoles } from '../../src/db/repositories/patterns.js';
import { createBlast, transition, replaceDecks } from '../../src/db/repositories/blasts.js';
import {
  createProduct,
  createMagazine,
  createBatch,
  recordMovement,
} from '../../src/db/repositories/explosives.js';
import { layoutPattern } from '../../src/domain/geometry/pattern.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';
import { insertRow } from '../../src/db/repository.js';

let db;
let siteId;
let magazineId;
let productId;
const clock = fixedClock('2026-01-08T06:00:00Z');
const context = () => ({ db, clock, logger: silentLogger() });

function batchWithStock(quantity, overrides = {}) {
  const batch = createBatch(
    db,
    {
      productId,
      batchCode: overrides.batchCode ?? 'L2025-114',
      expiresOn: overrides.expiresOn ?? '2027-01-01',
    },
    { clock },
  );
  recordMovement(
    db,
    { magazineId, batchId: batch.id, movement: 'receipt', quantity, massKg: quantity },
    { clock },
  );
  return batch;
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosivesMigration, blasting, operations]);
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, { clock }).id;
  insertRow(db, 'person', {
    id: 'per_1',
    name: 'M Cronin',
    roles: 'shotfirer',
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  productId = createProduct(
    db,
    {
      code: 'EM-115',
      name: 'Pumped emulsion',
      kind: 'bulk_emulsion',
      densityKgM3: 1150,
      sleepTimeHours: 72,
    },
    { clock },
  ).id;
  magazineId = createMagazine(
    db,
    { siteId, name: 'Upper store', netExplosiveLimitKg: 1000 },
    { clock },
  ).id;
});

afterEach(() => closeDatabase(db));

describe('the stock sweep', () => {
  it('says so when everything is in order', async () => {
    batchWithStock(400);
    const result = await runJob(stockSweepJob(), context());
    expect(result.found).toBe(0);
    expect(result.note).toContain('inside its licence');
  });

  it('flags a magazine close to its licence', async () => {
    batchWithStock(950);
    const result = await runJob(stockSweepJob(), context());
    expect(result.data.magazines[0].rule).toBe('magazine.near_licence');
  });

  it('flags a magazine over its licence', () => {
    const batch = batchWithStock(950);
    recordMovement(
      db,
      {
        magazineId,
        batchId: batch.id,
        movement: 'receipt',
        quantity: 200,
        massKg: 200,
        force: true,
      },
      { clock },
    );
    return runJob(stockSweepJob(), context()).then((result) => {
      expect(
        result.data.magazines.some((finding) => finding.rule === 'magazine.over_licence'),
      ).toBe(true);
    });
  });

  it('flags a batch that has gone out of date', async () => {
    batchWithStock(100, { expiresOn: '2025-06-01' });
    const result = await runJob(stockSweepJob(), context());
    expect(result.data.batches[0].status).toBe('expired');
  });

  it('flags a batch about to go out of date', async () => {
    batchWithStock(100, { expiresOn: '2026-01-20' });
    const result = await runJob(stockSweepJob(), context());
    expect(result.data.batches[0].status).toBe('expiring');
  });

  it('leaves a closed magazine out of it', async () => {
    batchWithStock(950);
    db.prepare("UPDATE magazine SET status = 'closed' WHERE id = ?").run(magazineId);
    const result = await runJob(stockSweepJob(), context());
    expect(result.examined).toBe(0);
  });
});

describe('sleeping holes', () => {
  function loadedBlast(loadedAt) {
    const benchId = createBench(
      db,
      {
        siteId,
        name: 'North 60',
        crestLevelM: 84,
        toeLevelM: 69,
        rockType: 'dolerite',
        rockDensityKgM3: 2900,
      },
      { clock },
    ).id;
    const pattern = createPattern(
      db,
      {
        benchId,
        reference: 'MDW-2026-001-P',
        holeDiameterMm: 102,
        nominalBurdenM: 3,
        nominalSpacingM: 3.5,
        rowCount: 1,
        holesPerRow: 2,
        benchHeightM: 15,
      },
      { clock },
    );
    replaceHoles(
      db,
      pattern.id,
      layoutPattern({
        origin: { easting: 1000, northing: 2000, level: 84 },
        faceBearingDeg: 0,
        layout: 'single_row',
        rowCount: 1,
        holesPerRow: 2,
        burdenM: 3,
        spacingM: 3.5,
        benchHeightM: 15,
        diameterMm: 102,
      }).holes,
      { clock },
    );
    const holes = listHoles(db, pattern.id);
    const blast = createBlast(
      db,
      { siteId, patternId: pattern.id, reference: 'MDW-2026-001' },
      { clock },
    );
    transition(db, blast.id, 'complete_design', {}, { clock });
    transition(db, blast.id, 'submit', {}, { clock });
    transition(db, blast.id, 'approve', { approverId: 'per_1' }, { clock });
    transition(db, blast.id, 'load', { shotfirerId: 'per_1' }, { clock });
    replaceDecks(
      db,
      blast.id,
      holes.map((hole) => ({
        holeId: hole.id,
        deckNumber: 1,
        kind: 'charge',
        productId,
        fromToeM: 0,
        toToeM: 12,
        massKg: 100,
        primed: true,
      })),
      { clock },
    );
    db.prepare('UPDATE blast SET updated_at = ? WHERE id = ?').run(loadedAt, blast.id);
    return blast.id;
  }

  it('says nothing when everything was loaded this morning', async () => {
    loadedBlast('2026-01-08T05:00:00.000Z');
    const result = await runJob(sleepingHolesJob(), context());
    expect(result.found).toBe(0);
    expect(result.note).toContain('nothing loaded');
  });

  it('flags a shot left past the sleep time of what is in it', async () => {
    loadedBlast('2026-01-01T06:00:00.000Z');
    const result = await runJob(sleepingHolesJob(), context());
    expect(result.found).toBe(1);
    expect(result.data.overdue[0].productCode).toBe('EM-115');
    expect(result.data.overdue[0].hoursLoaded).toBeGreaterThan(72);
  });

  it('looks only at shots that are still loaded', async () => {
    const blastId = loadedBlast('2026-01-01T06:00:00.000Z');
    db.prepare("UPDATE blast SET state = 'fired' WHERE id = ?").run(blastId);
    expect((await runJob(sleepingHolesJob(), context())).examined).toBe(0);
  });
});
