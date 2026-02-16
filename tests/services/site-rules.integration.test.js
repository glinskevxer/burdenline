import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase } from '../helpers/database.js';
import { createSite, createBench } from '../../src/db/repositories/sites.js';
import { setRules } from '../../src/db/repositories/site-rules.js';
import { createDesignService } from '../../src/services/design.service.js';
import { createFiringService } from '../../src/services/firing.service.js';
import { createBlast, transition } from '../../src/db/repositories/blasts.js';
import { parseProduct } from '../../src/domain/charging/products.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';
import { seedPerson } from '../helpers/database.js';

let db;
let siteId;
let benchId;
let design;
const clock = fixedClock('2026-02-17T13:00:00Z');
const context = { clock };

const catalogue = [
  parseProduct({
    code: 'ANFO-80',
    name: 'Ammonium nitrate fuel oil',
    kind: 'bulk_anfo',
    densityKgM3: 800,
    relativeWeightStrength: 100,
    minimumDiameterMm: 50,
  }),
];

const layout = {
  origin: { easting: 1000, northing: 2000, level: 84 },
  faceBearingDeg: 0,
  layout: 'square',
  rowCount: 1,
  holesPerRow: 4,
  burdenM: 3,
  spacingM: 3.5,
  subdrillM: 1,
  diameterMm: 102,
};

beforeEach(async () => {
  db = await openTestDatabase();
  seedPerson(db);
  siteId = createSite(db, { code: 'MDW', name: 'Midway', timeZone: 'Europe/Dublin' }, context).id;
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
  design = createDesignService({ db, clock, logger: silentLogger() });
});

afterEach(() => closeTestDatabase(db));

function laidOut(reference = 'MDW-2026-020') {
  return design.layOut({ benchId, reference, design: layout }).pattern.id;
}

describe('the design service reads the rules the site set', () => {
  it('uses the defaults when the site has set nothing', () => {
    const patternId = laidOut();
    const rules = design.rulesForPattern(patternId, 'charge');
    expect(rules.minimumStemmingDiameters).toBe(20);
    expect(design.planCharges({ patternId, catalogue, powderFactorKgM3: 0.55 }).checks.valid).toBe(
      true,
    );
  });

  it('follows a longer stemming rule once the site sets one', () => {
    setRules(db, { siteId, ruleSet: 'charge', values: { minimumStemmingDiameters: 40 } }, context);
    const patternId = laidOut();
    const planned = design.planCharges({ patternId, catalogue, powderFactorKgM3: 0.55 });
    expect(planned.plan.holes[0].stemmingM).toBe(4.08);
  });

  it('lets a caller override the site rules for a what if', () => {
    setRules(db, { siteId, ruleSet: 'charge', values: { minimumStemmingDiameters: 40 } }, context);
    const patternId = laidOut();
    const planned = design.planCharges({
      patternId,
      catalogue,
      powderFactorKgM3: 0.55,
      rules: { ...design.rulesForPattern(patternId, 'charge'), minimumStemmingDiameters: 20 },
    });
    expect(planned.plan.holes[0].stemmingM).toBe(2.1);
  });

  it('follows the timing rules the site set', () => {
    setRules(
      db,
      { siteId, ruleSet: 'timing', values: { minimumInterHoleMsPerMetre: 20 } },
      context,
    );
    const patternId = laidOut();
    const plan = design.planCharges({ patternId, catalogue, powderFactorKgM3: 0.55 }).plan;
    const tieIn = {
      initiationHole: 1,
      holes: [1, 2, 3, 4].map((holeNumber) => ({ holeNumber, inHoleDelayMs: 500 })),
      connectors: [1, 2, 3].map((from) => ({ fromHole: from, toHole: from + 1, delayMs: 25 })),
    };
    const timing = design.planTiming({ patternId, plan, tieIn });
    expect(timing.checks.valid).toBe(false);
  });
});

describe('the firing service reads the weather rules the site set', () => {
  const observation = {
    observedAt: '2026-02-17T13:00:00.000Z',
    windSpeedMs: 10,
    windBearingDeg: 90,
    temperatureC: 9,
    temperatureAt10mC: 11,
  };

  function loadedBlast() {
    const blast = createBlast(db, { siteId, reference: 'MDW-2026-021' }, context);
    transition(db, blast.id, 'complete_design', {}, context);
    transition(db, blast.id, 'submit', {}, context);
    transition(db, blast.id, 'approve', { approverId: 'per_1' }, context);
    transition(db, blast.id, 'load', { shotfirerId: 'per_1' }, context);
    transition(db, blast.id, 'tie_in', {}, context);
    return blast.id;
  }

  it('stops a shot under an inversion by default', () => {
    const firing = createFiringService({ db, clock, logger: silentLogger() });
    const blastId = loadedBlast();
    firing.startClearance({ blastId });
    const decision = firing.gate({ blastId, observation });
    expect(decision.blocking.some((item) => item.rule === 'weather.inversion')).toBe(true);
  });

  it('lets it through once the site says an inversion does not block', () => {
    setRules(db, { siteId, ruleSet: 'weather', values: { inversionBlocks: false } }, context);
    const firing = createFiringService({ db, clock, logger: silentLogger() });
    const blastId = loadedBlast();
    firing.startClearance({ blastId });
    const decision = firing.gate({ blastId, observation });
    expect(decision.blocking.some((item) => item.rule === 'weather.inversion')).toBe(false);
  });

  it('stops it again once the site tightens the wind limit', () => {
    setRules(db, { siteId, ruleSet: 'weather', values: { maximumWindSpeedMs: 5 } }, context);
    const firing = createFiringService({ db, clock, logger: silentLogger() });
    const blastId = loadedBlast();
    firing.startClearance({ blastId });
    const decision = firing.gate({ blastId, observation });
    expect(decision.blocking.some((item) => item.rule === 'weather.wind_too_strong')).toBe(true);
  });
});
