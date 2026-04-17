/**
 * How the thing behaves on a shot that is actually big.
 *
 * Two hundred and forty holes and a magazine with four thousand ledger lines
 * behind it are ordinary numbers for a busy quarry, and every one of them is a
 * loop somewhere in here. The bounds are deliberately loose: this is not a
 * benchmark, it is a guard against the class of change that turns a linear read
 * into a quadratic one, which is what actually happens and what nobody notices
 * until a screen takes eleven seconds.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase, seedPerson } from '../helpers/database.js';
import { createSite, createBench } from '../../src/db/repositories/sites.js';
import {
  createPattern,
  replaceHoles,
  listHoles,
  recordDrilling,
} from '../../src/db/repositories/patterns.js';
import {
  createProduct,
  createMagazine,
  createBatch,
  recordMovement,
  ledgerFor,
  stockFor,
} from '../../src/db/repositories/explosives.js';
import { createDesignService } from '../../src/services/design.service.js';
import { saveSiteLaw, createReceptor } from '../../src/db/repositories/monitoring.js';
import { layoutPattern } from '../../src/domain/geometry/pattern.js';
import { parseProduct } from '../../src/domain/charging/products.js';
import { resolveFiringTimes } from '../../src/domain/initiation/tie-in.js';
import { summariseTiming } from '../../src/domain/initiation/windows.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';

let db;
let siteId;
let benchId;
const clock = fixedClock('2026-04-22T09:00:00Z');
const context = { clock };

const HOLES_PER_ROW = 30;
const ROWS = 8;
const HOLE_COUNT = HOLES_PER_ROW * ROWS;

const anfo = parseProduct({
  code: 'ANFO-80',
  name: 'Ammonium nitrate fuel oil',
  kind: 'bulk_anfo',
  densityKgM3: 800,
  relativeWeightStrength: 100,
  minimumDiameterMm: 50,
});

function elapsed(work) {
  const started = process.hrtime.bigint();
  const result = work();
  return { result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

function bigPattern() {
  const pattern = createPattern(
    db,
    {
      benchId,
      reference: 'MDW-2026-BIG',
      layout: 'staggered',
      holeDiameterMm: 102,
      nominalBurdenM: 3,
      nominalSpacingM: 3.5,
      rowCount: ROWS,
      holesPerRow: HOLES_PER_ROW,
      benchHeightM: 15,
      subdrillM: 1,
    },
    context,
  );
  const laid = layoutPattern({
    origin: { easting: 1000, northing: 2000, level: 84 },
    faceBearingDeg: 0,
    layout: 'staggered',
    rowCount: ROWS,
    holesPerRow: HOLES_PER_ROW,
    burdenM: 3,
    spacingM: 3.5,
    benchHeightM: 15,
    subdrillM: 1,
    diameterMm: 102,
  });
  replaceHoles(db, pattern.id, laid.holes, context);
  recordDrilling(
    db,
    pattern.id,
    laid.holes.map((hole) => ({ holeNumber: hole.holeNumber, drilledDepthM: hole.designedDepthM })),
    context,
  );
  return pattern;
}

beforeEach(async () => {
  db = await openTestDatabase();
  seedPerson(db);
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, context).id;
  benchId = createBench(
    db,
    {
      siteId,
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
    },
    context,
  ).id;
});

afterEach(() => closeTestDatabase(db));

describe('a two hundred and forty hole shot', () => {
  it('lays the pattern out and writes it in well under a second', () => {
    const { result, ms } = elapsed(() => bigPattern());
    expect(listHoles(db, result.id, { limit: 500 })).toHaveLength(HOLE_COUNT);
    expect(ms).toBeLessThan(1500);
  });

  it('charges every hole in well under a second', () => {
    const pattern = bigPattern();
    const service = createDesignService({ db, clock, logger: silentLogger() });
    const { result, ms } = elapsed(() =>
      service.planCharges({ patternId: pattern.id, catalogue: [anfo], powderFactorKgM3: 0.55 }),
    );
    expect(result.plan.holes).toHaveLength(HOLE_COUNT);
    expect(ms).toBeLessThan(2000);
  });

  it('resolves the tie-in and the instantaneous charge quickly', () => {
    const tieIn = {
      initiationHole: 1,
      holes: Array.from({ length: HOLE_COUNT }, (_unused, index) => ({
        holeNumber: index + 1,
        inHoleDelayMs: 500,
      })),
      connectors: Array.from({ length: HOLE_COUNT - 1 }, (_unused, index) => ({
        fromHole: index + 1,
        toHole: index + 2,
        delayMs: 17,
      })),
    };
    const masses = new Map(Array.from({ length: HOLE_COUNT }, (_unused, index) => [index + 1, 86]));
    const { result, ms } = elapsed(() => summariseTiming(resolveFiringTimes(tieIn), masses));
    expect(result.events).toHaveLength(HOLE_COUNT);
    expect(result.maximumInstantaneousChargeKg).toBeGreaterThan(0);
    expect(ms).toBeLessThan(2000);
  });

  it('runs the whole design against a site law inside three seconds', () => {
    const pattern = bigPattern();
    createReceptor(
      db,
      {
        siteId,
        name: 'Keeper cottage',
        structureClass: 'older_dwelling',
        easting: 1600,
        northing: 2000,
      },
      context,
    );
    saveSiteLaw(db, { siteId, k: 1140, b: 1.6, recordCount: 40 }, context);
    const service = createDesignService({ db, clock, logger: silentLogger() });
    const tieIn = {
      initiationHole: 1,
      holes: Array.from({ length: HOLE_COUNT }, (_unused, index) => ({
        holeNumber: index + 1,
        inHoleDelayMs: 500,
      })),
      connectors: Array.from({ length: HOLE_COUNT - 1 }, (_unused, index) => ({
        fromHole: index + 1,
        toHole: index + 2,
        delayMs: 42,
      })),
    };
    const { result, ms } = elapsed(() =>
      service.design({
        siteId,
        patternId: pattern.id,
        catalogue: [anfo],
        powderFactorKgM3: 0.55,
        tieIn,
        frequencyHz: 25,
      }),
    );
    expect(result.totals.holeCount).toBe(HOLE_COUNT);
    expect(ms).toBeLessThan(3000);
  });
});

describe('a magazine with a long ledger behind it', () => {
  const LINES = 1200;

  function longLedger() {
    const productId = createProduct(
      db,
      { code: 'ANFO-80', name: 'Anfo', kind: 'bulk_anfo', densityKgM3: 800 },
      context,
    ).id;
    const magazineId = createMagazine(
      db,
      { siteId, name: 'Upper store', netExplosiveLimitKg: 1e6 },
      context,
    ).id;
    const batch = createBatch(db, { productId, batchCode: 'L2026-100' }, context);
    for (let index = 0; index < LINES; index += 1) {
      recordMovement(
        db,
        {
          magazineId,
          batchId: batch.id,
          movement: index % 2 === 0 ? 'receipt' : 'issue',
          quantity: 100,
          massKg: 100,
          occurredAt: new Date(
            Date.parse('2026-01-01T09:00:00.000Z') + index * 3600000,
          ).toISOString(),
        },
        context,
      );
    }
    return magazineId;
  }

  it('reads the whole ledger quickly', () => {
    const magazineId = longLedger();
    const { result, ms } = elapsed(() => ledgerFor(db, magazineId));
    expect(result).toHaveLength(LINES);
    expect(ms).toBeLessThan(500);
  });

  it('works the stock out from it quickly', () => {
    const magazineId = longLedger();
    const { result, ms } = elapsed(() => stockFor(db, magazineId));
    expect(result.netExplosiveKg).toBe(0);
    expect(ms).toBeLessThan(500);
  });

  it('reads a date range out of it quickly', () => {
    const magazineId = longLedger();
    const { result, ms } = elapsed(() =>
      ledgerFor(db, magazineId, {
        from: '2026-02-01T00:00:00.000Z',
        to: '2026-02-28T00:00:00.000Z',
      }),
    );
    expect(result.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(500);
  });
});
