import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { createSite, createBench } from '../../src/db/repositories/sites.js';
import { createReceptor, saveSiteLaw } from '../../src/db/repositories/monitoring.js';
import { recordDrilling } from '../../src/db/repositories/patterns.js';
import { createDesignService } from '../../src/services/design.service.js';
import { parseProduct } from '../../src/domain/charging/products.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';
import { ValidationError } from '../../src/lib/errors.js';

let db;
let service;
let siteId;
let benchId;
const clock = fixedClock('2025-08-18T09:00:00Z');

const catalogue = [
  parseProduct({
    code: 'ANFO-80',
    name: 'Ammonium nitrate fuel oil',
    kind: 'bulk_anfo',
    densityKgM3: 800,
    relativeWeightStrength: 100,
    waterResistance: 'none',
    minimumDiameterMm: 50,
  }),
  parseProduct({
    code: 'EM-115',
    name: 'Pumped emulsion',
    kind: 'bulk_emulsion',
    densityKgM3: 1150,
    relativeWeightStrength: 82,
    waterResistance: 'excellent',
    minimumDiameterMm: 76,
  }),
];

const design = {
  origin: { easting: 1000, northing: 2000, level: 84 },
  faceBearingDeg: 0,
  layout: 'square',
  rowCount: 2,
  holesPerRow: 4,
  burdenM: 3,
  spacingM: 3.5,
  subdrillM: 1,
  inclinationDeg: 0,
  diameterMm: 102,
};

function tieInFor(holeCount) {
  return {
    initiationHole: 1,
    holes: Array.from({ length: holeCount }, (_unused, index) => ({
      holeNumber: index + 1,
      inHoleDelayMs: 500,
    })),
    connectors: Array.from({ length: holeCount - 1 }, (_unused, index) => ({
      fromHole: index + 1,
      toHole: index + 2,
      delayMs: 42,
    })),
  };
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations]);
  service = createDesignService({ db, clock, logger: silentLogger() });
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, { clock }).id;
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
    { clock },
  ).id;
});

afterEach(() => closeDatabase(db));

describe('layOut', () => {
  it('writes the pattern and its holes', () => {
    const result = service.layOut({ benchId, reference: 'MDW-2025-014', design });
    expect(result.holes).toHaveLength(8);
    expect(result.pattern.benchHeightM).toBe(15);
  });

  it('takes the bench height from the bench when the design leaves it out', () => {
    const result = service.layOut({ benchId, reference: 'MDW-2025-014', design });
    expect(result.pattern.benchHeightM).toBe(15);
    expect(result.summary.volumeM3).toBe(1260);
  });

  it('honours a bench height the designer set', () => {
    const result = service.layOut({
      benchId,
      reference: 'MDW-2025-014',
      design: { ...design, benchHeightM: 12 },
    });
    expect(result.pattern.benchHeightM).toBe(12);
  });
});

describe('planCharges', () => {
  function laidOut() {
    return service.layOut({ benchId, reference: 'MDW-2025-014', design }).pattern.id;
  }

  it('charges every hole and adds the totals up', () => {
    const patternId = laidOut();
    const result = service.planCharges({ patternId, catalogue, powderFactorKgM3: 0.55 });
    expect(result.plan.holes).toHaveLength(8);
    expect(result.plan.achievedPowderFactorKgM3).toBeCloseTo(0.55, 2);
    expect(result.checks.valid).toBe(true);
  });

  it('writes a load sheet line per hole', () => {
    const patternId = laidOut();
    const result = service.planCharges({ patternId, catalogue, powderFactorKgM3: 0.55 });
    expect(result.sheet[0]).toMatchObject({ hole: 1, product: 'ANFO-80' });
  });

  it('switches product where the rig found water', () => {
    const patternId = laidOut();
    recordDrilling(
      db,
      patternId,
      [{ holeNumber: 2, drilledDepthM: 16, condition: 'wet', waterDepthM: 4 }],
      { clock },
    );
    const result = service.planCharges({ patternId, catalogue, powderFactorKgM3: 0.55 });
    const wet = result.plan.holes.find((hole) => hole.holeNumber === 2);
    expect(wet.productCode).toBe('EM-115');
  });

  it('refuses a pattern with no holes', () => {
    const empty = service.layOut({ benchId, reference: 'MDW-2025-015', design }).pattern.id;
    db.prepare('DELETE FROM hole WHERE pattern_id = ?').run(empty);
    expect(() =>
      service.planCharges({ patternId: empty, catalogue, powderFactorKgM3: 0.55 }),
    ).toThrow(ValidationError);
  });
});

describe('planTiming', () => {
  it('works the instantaneous charge out from the tie-in', () => {
    const patternId = service.layOut({ benchId, reference: 'MDW-2025-014', design }).pattern.id;
    const charging = service.planCharges({ patternId, catalogue, powderFactorKgM3: 0.55 });
    const timing = service.planTiming({ patternId, plan: charging.plan, tieIn: tieInFor(8) });
    expect(timing.timing.maximumInstantaneousChargeKg).toBeCloseTo(86.6, 0);
    expect(timing.checks.valid).toBe(true);
  });

  it('catches a tie-in that fires neighbours together', () => {
    const patternId = service.layOut({ benchId, reference: 'MDW-2025-014', design }).pattern.id;
    const charging = service.planCharges({ patternId, catalogue, powderFactorKgM3: 0.55 });
    const tieIn = tieInFor(8);
    tieIn.connectors = tieIn.connectors.map((connector) => ({ ...connector, delayMs: 0 }));
    const timing = service.planTiming({ patternId, plan: charging.plan, tieIn });
    expect(timing.checks.valid).toBe(false);
    expect(timing.timing.maximumInstantaneousChargeKg).toBeGreaterThan(600);
  });
});

describe('assessVibration', () => {
  function seededSite() {
    createReceptor(
      db,
      {
        siteId,
        name: 'Keeper cottage',
        structureClass: 'older_dwelling',
        easting: 1400,
        northing: 2000,
      },
      { clock },
    );
    saveSiteLaw(db, { siteId, k: 1140, b: 1.6, recordCount: 24, rSquared: 0.9 }, { clock });
  }

  it('refuses to assess a site with no fitted law', () => {
    const patternId = service.layOut({ benchId, reference: 'MDW-2025-014', design }).pattern.id;
    expect(() => service.assessVibration({ siteId, patternId, instantaneousChargeKg: 86 })).toThrow(
      /no fitted vibration law/,
    );
  });

  it('judges the design against every receptor', () => {
    seededSite();
    const patternId = service.layOut({ benchId, reference: 'MDW-2025-014', design }).pattern.id;
    const result = service.assessVibration({
      siteId,
      patternId,
      instantaneousChargeKg: 86,
      frequencyHz: 20,
    });
    expect(result.receptorCount).toBe(1);
    expect(result.assessment.results[0].receptorName).toBe('Keeper cottage');
    expect(result.allowances.binding.receptorId).toBe(result.assessment.results[0].receptorId);
  });

  it('says how far the charge has to come down when it does not fit', () => {
    seededSite();
    const patternId = service.layOut({ benchId, reference: 'MDW-2025-014', design }).pattern.id;
    const result = service.assessVibration({
      siteId,
      patternId,
      instantaneousChargeKg: 4000,
      frequencyHz: 20,
    });
    expect(result.assessment.compliant).toBe(false);
    expect(result.reduction.needed).toBe(true);
    expect(result.reduction.toKg).toBeLessThan(4000);
  });
});

describe('design', () => {
  beforeEach(() => {
    createReceptor(
      db,
      {
        siteId,
        name: 'Keeper cottage',
        structureClass: 'older_dwelling',
        easting: 1400,
        northing: 2000,
      },
      { clock },
    );
    saveSiteLaw(db, { siteId, k: 1140, b: 1.6, recordCount: 24 }, { clock });
  });

  it('runs the whole thing in the right order', () => {
    const patternId = service.layOut({ benchId, reference: 'MDW-2025-014', design }).pattern.id;
    const result = service.design({
      siteId,
      patternId,
      catalogue,
      powderFactorKgM3: 0.55,
      tieIn: tieInFor(8),
      frequencyHz: 25,
    });
    expect(result.totals.holeCount).toBe(8);
    expect(result.totals.instantaneousChargeKg).toBeGreaterThan(0);
    expect(result.totals.powderFactorKgM3).toBeCloseTo(0.55, 2);
    expect(result.violations).toEqual([]);
  });

  it('reports a vibration failure as a violation like any other', () => {
    createReceptor(
      db,
      {
        siteId,
        name: 'Gate lodge',
        structureClass: 'older_dwelling',
        easting: 1120,
        northing: 2000,
      },
      { clock },
    );
    const patternId = service.layOut({ benchId, reference: 'MDW-2025-014', design }).pattern.id;
    const tieIn = tieInFor(8);
    tieIn.connectors = tieIn.connectors.map((connector) => ({ ...connector, delayMs: 0 }));
    const result = service.design({
      siteId,
      patternId,
      catalogue,
      powderFactorKgM3: 0.55,
      tieIn,
      frequencyHz: 25,
    });
    expect(result.violations.some((violation) => violation.rule === 'vibration.over_limit')).toBe(
      true,
    );
  });

  it('carries the worst receptor ratio in the totals', () => {
    const patternId = service.layOut({ benchId, reference: 'MDW-2025-014', design }).pattern.id;
    const result = service.design({
      siteId,
      patternId,
      catalogue,
      powderFactorKgM3: 0.55,
      tieIn: tieInFor(8),
      frequencyHz: 25,
    });
    expect(result.totals.worstReceptorRatio).toBeGreaterThan(0);
  });
});
