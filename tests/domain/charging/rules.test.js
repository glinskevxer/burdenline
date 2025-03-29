import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CHARGE_RULES,
  ruleSet,
  minimumStemmingM,
  maximumStemmingM,
  checkHoleCharge,
  checkStemmingMaterial,
  checkPattern,
} from '../../../src/domain/charging/rules.js';
import { buildColumn } from '../../../src/domain/charging/deck.js';
import { parseProduct } from '../../../src/domain/charging/products.js';

const anfo = parseProduct({
  code: 'ANFO-80',
  name: 'Ammonium nitrate fuel oil',
  kind: 'bulk_anfo',
  densityKgM3: 800,
  relativeWeightStrength: 100,
});

const hole = { holeNumber: 1, diameterMm: 102, nominalBurdenM: 3, measuredBurdenM: 3 };

function column(overrides = {}) {
  return buildColumn({
    holeLengthM: 16,
    diameterMm: 102,
    stemmingM: 3,
    charges: [{ product: anfo, lengthM: 13 }],
    ...overrides,
  });
}

describe('the rule set', () => {
  it('hands back the defaults frozen', () => {
    expect(Object.isFrozen(ruleSet())).toBe(true);
    expect(ruleSet().minimumStemmingDiameters).toBe(20);
  });

  it('lets a site override one number and keep the rest', () => {
    const site = ruleSet({ minimumStemmingDiameters: 25 });
    expect(site.minimumStemmingDiameters).toBe(25);
    expect(site.minimumChargeLengthM).toBe(DEFAULT_CHARGE_RULES.minimumChargeLengthM);
  });
});

describe('stemming length', () => {
  it('takes whichever of the two floors is higher', () => {
    expect(minimumStemmingM(102, 3)).toBe(2.1);
    expect(minimumStemmingM(102, 4)).toBe(2.8);
  });

  it('follows the diameter when the burden is small', () => {
    expect(minimumStemmingM(165, 2)).toBe(3.3);
  });

  it('caps the stemming against the burden as well', () => {
    expect(maximumStemmingM(3)).toBe(3.9);
  });
});

describe('checkHoleCharge', () => {
  it('passes a hole loaded to the design', () => {
    expect(checkHoleCharge(hole, column())).toEqual([]);
  });

  it('catches stemming under the floor', () => {
    const violations = checkHoleCharge(
      hole,
      column({ stemmingM: 1.5, charges: [{ product: anfo, lengthM: 13 }] }),
    );
    expect(violations.map((violation) => violation.rule)).toContain('stemming.minimum');
    expect(violations[0].required).toBe(2.1);
  });

  it('catches stemming so long the collar will not break', () => {
    const violations = checkHoleCharge(
      hole,
      column({ stemmingM: 5, charges: [{ product: anfo, lengthM: 10 }] }),
    );
    expect(violations.map((violation) => violation.rule)).toContain('stemming.maximum');
  });

  it('catches a burden thinner than anything the site will fire', () => {
    const violations = checkHoleCharge({ ...hole, measuredBurdenM: 1.1 }, column());
    expect(violations.map((violation) => violation.rule)).toContain('burden.minimum');
  });

  it('catches a measured burden well past the design', () => {
    const violations = checkHoleCharge(
      { ...hole, measuredBurdenM: 5 },
      column({ stemmingM: 3.5, charges: [{ product: anfo, lengthM: 12 }] }),
    );
    expect(violations.map((violation) => violation.rule)).toContain('burden.excessive');
  });

  it('catches a deck too short to fire', () => {
    const short = buildColumn({
      holeLengthM: 16,
      diameterMm: 102,
      stemmingM: 3,
      charges: [
        { product: anfo, lengthM: 0.3 },
        { gapM: 1.5, product: anfo, lengthM: 10 },
      ],
    });
    expect(checkHoleCharge(hole, short).map((v) => v.rule)).toContain('charge.deck_too_short');
  });

  it('catches decks too close together', () => {
    const tight = buildColumn({
      holeLengthM: 16,
      diameterMm: 102,
      stemmingM: 3,
      charges: [
        { product: anfo, lengthM: 6 },
        { gapM: 0.5, product: anfo, lengthM: 6.5 },
      ],
    });
    expect(checkHoleCharge(hole, tight).map((v) => v.rule)).toContain('deck.separation');
  });

  it('catches a hole with nothing primed', () => {
    const unprimed = column();
    unprimed.decks[0].primed = false;
    unprimed.decks[0].boosterCount = 0;
    expect(checkHoleCharge(hole, unprimed).map((v) => v.rule)).toContain('primer.none_in_hole');
  });

  it('catches a primed deck with no booster', () => {
    const unboosted = column();
    unboosted.decks[0].boosterCount = 0;
    expect(checkHoleCharge(hole, unboosted).map((v) => v.rule)).toContain('primer.missing');
  });

  it('catches too many boosters in one deck', () => {
    const overprimed = column();
    overprimed.decks[0].boosterCount = 4;
    expect(checkHoleCharge(hole, overprimed).map((v) => v.rule)).toContain('primer.excessive');
  });

  it('reports every failure rather than the first', () => {
    const violations = checkHoleCharge(
      { ...hole, measuredBurdenM: 1.0 },
      column({ stemmingM: 1, charges: [{ product: anfo, lengthM: 14 }] }),
    );
    expect(violations.length).toBeGreaterThan(1);
  });

  it('skips the burden rules when nothing has measured the burden', () => {
    const noBurden = { holeNumber: 4, diameterMm: 102 };
    expect(checkHoleCharge(noBurden, column())).toEqual([]);
  });

  it('follows a site that runs longer stemming', () => {
    const strict = ruleSet({ minimumStemmingDiameters: 30 });
    expect(checkHoleCharge(hole, column(), strict).map((v) => v.rule)).toContain(
      'stemming.minimum',
    );
  });
});

describe('checkStemmingMaterial', () => {
  it('passes angular chippings of about a tenth of the diameter', () => {
    expect(checkStemmingMaterial(102, 8)).toEqual([]);
  });

  it('rejects drill cuttings, which blow straight out', () => {
    expect(checkStemmingMaterial(102, 2).map((v) => v.rule)).toContain('stemming.material_fine');
  });

  it('rejects material that will bridge the hole', () => {
    expect(checkStemmingMaterial(102, 25).map((v) => v.rule)).toContain('stemming.material_coarse');
  });
});

describe('checkPattern', () => {
  it('passes a pattern where every hole is right', () => {
    const loaded = [1, 2, 3].map((number) => ({
      hole: { ...hole, holeNumber: number },
      column: column(),
    }));
    expect(checkPattern(loaded)).toMatchObject({ valid: true, holesWithViolations: 0 });
  });

  it('counts the holes at fault and groups by rule', () => {
    const bad = column({ stemmingM: 1, charges: [{ product: anfo, lengthM: 14 }] });
    const loaded = [
      { hole: { ...hole, holeNumber: 1 }, column: column() },
      { hole: { ...hole, holeNumber: 2 }, column: bad },
      { hole: { ...hole, holeNumber: 3 }, column: bad },
    ];
    const result = checkPattern(loaded);
    expect(result.valid).toBe(false);
    expect(result.holesWithViolations).toBe(2);
    expect(result.byRule['stemming.minimum']).toBe(2);
  });
});
