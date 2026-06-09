import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase, seedPerson } from '../../helpers/database.js';
import {
  metresDrilled,
  explosiveUsed,
  totalExplosiveKg,
} from '../../../src/db/repositories/blast-facts.js';
import { createSite, createBench } from '../../../src/db/repositories/sites.js';
import {
  createPattern,
  replaceHoles,
  recordDrilling,
} from '../../../src/db/repositories/patterns.js';
import { createBlast } from '../../../src/db/repositories/blasts.js';
import {
  createProduct,
  createMagazine,
  createBatch,
  recordMovement,
} from '../../../src/db/repositories/explosives.js';
import { layoutPattern } from '../../../src/domain/geometry/pattern.js';
import { fixedClock } from '../../../src/lib/clock.js';

let db;
let siteId;
let patternId;
let blastId;
let magazineId;
let batchId;
const clock = fixedClock('2026-06-10T09:00:00Z');
const context = { clock };

beforeEach(async () => {
  db = await openTestDatabase();
  seedPerson(db);
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, context).id;
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
    context,
  ).id;
  const pattern = createPattern(
    db,
    {
      benchId,
      reference: 'MDW-2026-070-P',
      holeDiameterMm: 102,
      nominalBurdenM: 3,
      nominalSpacingM: 3.5,
      rowCount: 1,
      holesPerRow: 4,
      benchHeightM: 15,
      subdrillM: 1,
    },
    context,
  );
  patternId = pattern.id;
  replaceHoles(
    db,
    patternId,
    layoutPattern({
      origin: { easting: 1000, northing: 2000, level: 84 },
      faceBearingDeg: 0,
      layout: 'single_row',
      rowCount: 1,
      holesPerRow: 4,
      burdenM: 3,
      spacingM: 3.5,
      benchHeightM: 15,
      subdrillM: 1,
      diameterMm: 102,
    }).holes,
    context,
  );
  blastId = createBlast(db, { siteId, patternId, reference: 'MDW-2026-070' }, context).id;
  const productId = createProduct(
    db,
    { code: 'ANFO-80', name: 'Anfo', kind: 'bulk_anfo', densityKgM3: 800 },
    context,
  ).id;
  magazineId = createMagazine(
    db,
    { siteId, name: 'Upper store', netExplosiveLimitKg: 8000 },
    context,
  ).id;
  batchId = createBatch(db, { productId, batchCode: 'L2026-090' }, context).id;
  recordMovement(
    db,
    { magazineId, batchId, movement: 'receipt', quantity: 2000, massKg: 2000 },
    context,
  );
});

afterEach(() => closeTestDatabase(db));

function move(movement, quantity) {
  return recordMovement(
    db,
    { magazineId, batchId, movement, quantity, massKg: quantity, blastId },
    context,
  );
}

describe('metresDrilled', () => {
  it('takes the design depth until the rig reports', () => {
    expect(metresDrilled(db, patternId)).toBe(64);
  });

  it('takes the drilled depth once it does', () => {
    recordDrilling(
      db,
      patternId,
      [
        { holeNumber: 1, drilledDepthM: 16.4 },
        { holeNumber: 2, drilledDepthM: 15.6 },
      ],
      context,
    );
    expect(metresDrilled(db, patternId)).toBe(64);
  });

  it('reads a shot with no pattern as no drilling', () => {
    expect(metresDrilled(db, null)).toBe(0);
  });
});

describe('explosiveUsed', () => {
  it('says nothing was recorded before anything moved', () => {
    expect(explosiveUsed(db, blastId)).toMatchObject({ source: 'nothing_recorded', products: [] });
  });

  it('falls back to issues net of returns', () => {
    move('issue', 1000);
    move('return', 150);
    const used = explosiveUsed(db, blastId);
    expect(used.source).toBe('issued_less_returns');
    expect(used.products[0].quantity).toBe(850);
  });

  it('prefers the consumption records once they are there', () => {
    move('issue', 1000);
    move('return', 150);
    move('consumption', 840);
    const used = explosiveUsed(db, blastId);
    expect(used.source).toBe('consumption');
    expect(used.products[0].quantity).toBe(840);
  });

  it('adds the kilograms up for the reports', () => {
    move('issue', 1000);
    expect(totalExplosiveKg(db, blastId)).toBe(1000);
  });

  it('gives every report the same figure for the same shot', () => {
    move('issue', 1000);
    move('return', 150);
    expect(totalExplosiveKg(db, blastId)).toBe(850);
    expect(explosiveUsed(db, blastId).products[0].quantity).toBe(850);
  });
});
