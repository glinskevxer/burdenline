/**
 * The rules a charge design has to satisfy.
 *
 * These are the numbers a site writes into its own blasting procedure, not laws
 * of nature, so the whole set is a value that a site can override. What is fixed
 * is how they are applied: every rule is checked against every hole, all the
 * failures come back together, and each one names the rule so that the report
 * can group them. A designer fixing one hole at a time because the checker stops
 * at the first failure is a designer who will be on the bench until dark.
 */

import { roundTo } from '../../lib/units.js';

export const DEFAULT_CHARGE_RULES = Object.freeze({
  minimumStemmingDiameters: 20,
  minimumStemmingBurdenRatio: 0.7,
  maximumStemmingBurdenRatio: 1.3,
  minimumChargeLengthM: 0.5,
  maximumChargeLengthDiameters: 800,
  minimumDeckSeparationM: 1,
  minimumBoosterPerDeck: 1,
  maximumBoosterPerDeck: 2,
  minimumBurdenM: 1.5,
  maximumBurdenRatio: 1.4,
  minimumStemmingSizeMm: 6,
  maximumStemmingSizeDiameterRatio: 0.1,
});

export function ruleSet(overrides = {}) {
  return Object.freeze({ ...DEFAULT_CHARGE_RULES, ...overrides });
}

/** Stemming is the collar length that holds the gases in. Too little and it blows out. */
export function minimumStemmingM(diameterMm, burdenM, rules = DEFAULT_CHARGE_RULES) {
  const byDiameter = (rules.minimumStemmingDiameters * diameterMm) / 1000;
  const byBurden = rules.minimumStemmingBurdenRatio * burdenM;
  return roundTo(Math.max(byDiameter, byBurden), 3);
}

export function maximumStemmingM(burdenM, rules = DEFAULT_CHARGE_RULES) {
  return roundTo(rules.maximumStemmingBurdenRatio * burdenM, 3);
}

/**
 * Check one loaded hole. `hole` carries the geometry and the measured burden,
 * `column` is what buildColumn produced.
 */
export function checkHoleCharge(hole, column, rules = DEFAULT_CHARGE_RULES) {
  const violations = [];
  const burden = hole.measuredBurdenM ?? hole.nominalBurdenM;
  const diameter = column.diameterMm ?? hole.diameterMm;

  if (burden !== undefined && burden !== null) {
    const floor = minimumStemmingM(diameter, burden, rules);
    if (column.stemmingM < floor - 1e-9) {
      violations.push({
        rule: 'stemming.minimum',
        holeNumber: hole.holeNumber,
        message: `stemming of ${column.stemmingM} m is under the ${floor} m this hole needs`,
        actual: column.stemmingM,
        required: floor,
      });
    }
    const ceiling = maximumStemmingM(burden, rules);
    if (column.stemmingM > ceiling + 1e-9) {
      violations.push({
        rule: 'stemming.maximum',
        holeNumber: hole.holeNumber,
        message: `stemming of ${column.stemmingM} m will leave the collar rock standing`,
        actual: column.stemmingM,
        required: ceiling,
      });
    }
    if (burden < rules.minimumBurdenM) {
      violations.push({
        rule: 'burden.minimum',
        holeNumber: hole.holeNumber,
        message: `a burden of ${burden} m is under the ${rules.minimumBurdenM} m floor`,
        actual: burden,
        required: rules.minimumBurdenM,
      });
    }
    if (hole.nominalBurdenM && burden > hole.nominalBurdenM * rules.maximumBurdenRatio) {
      violations.push({
        rule: 'burden.excessive',
        holeNumber: hole.holeNumber,
        message: `a measured burden of ${burden} m is well past the ${hole.nominalBurdenM} m design`,
        actual: burden,
        required: roundTo(hole.nominalBurdenM * rules.maximumBurdenRatio, 3),
      });
    }
  }

  const chargeDecks = column.decks.filter((deck) => deck.kind === 'charge');
  if (chargeDecks.length === 0) {
    violations.push({
      rule: 'charge.missing',
      holeNumber: hole.holeNumber,
      message: 'the hole has no charge in it',
    });
  }
  for (const deck of chargeDecks) {
    if (deck.lengthM < rules.minimumChargeLengthM) {
      violations.push({
        rule: 'charge.deck_too_short',
        holeNumber: hole.holeNumber,
        message: `a charge deck of ${deck.lengthM} m is too short to fire reliably`,
        actual: deck.lengthM,
        required: rules.minimumChargeLengthM,
      });
    }
    const longest = (rules.maximumChargeLengthDiameters * diameter) / 1000;
    if (deck.lengthM > longest) {
      violations.push({
        rule: 'charge.deck_too_long',
        holeNumber: hole.holeNumber,
        message: `a charge deck of ${deck.lengthM} m runs past ${roundTo(longest, 1)} m`,
        actual: deck.lengthM,
        required: roundTo(longest, 3),
      });
    }
    if (deck.primed && deck.boosterCount < rules.minimumBoosterPerDeck) {
      violations.push({
        rule: 'primer.missing',
        holeNumber: hole.holeNumber,
        message: 'a primed deck has no booster in it',
      });
    }
    if (deck.boosterCount > rules.maximumBoosterPerDeck) {
      violations.push({
        rule: 'primer.excessive',
        holeNumber: hole.holeNumber,
        message: `${deck.boosterCount} boosters in one deck`,
        actual: deck.boosterCount,
        required: rules.maximumBoosterPerDeck,
      });
    }
  }
  for (const deck of column.decks.filter((item) => item.kind === 'inert')) {
    if (deck.lengthM < rules.minimumDeckSeparationM) {
      violations.push({
        rule: 'deck.separation',
        holeNumber: hole.holeNumber,
        message: `${deck.lengthM} m between decks will let one shoot the other out`,
        actual: deck.lengthM,
        required: rules.minimumDeckSeparationM,
      });
    }
  }
  if (chargeDecks.length > 0 && !chargeDecks.some((deck) => deck.primed)) {
    violations.push({
      rule: 'primer.none_in_hole',
      holeNumber: hole.holeNumber,
      message: 'nothing in the hole is primed',
    });
  }
  return violations;
}

/** Stemming material has to be angular chippings of about a tenth of the diameter. */
export function checkStemmingMaterial(diameterMm, materialSizeMm, rules = DEFAULT_CHARGE_RULES) {
  const violations = [];
  if (materialSizeMm < rules.minimumStemmingSizeMm) {
    violations.push({
      rule: 'stemming.material_fine',
      message: `${materialSizeMm} mm stemming is too fine to lock in the collar`,
    });
  }
  const coarsest = diameterMm * rules.maximumStemmingSizeDiameterRatio;
  if (materialSizeMm > coarsest) {
    violations.push({
      rule: 'stemming.material_coarse',
      message: `${materialSizeMm} mm stemming will bridge in a ${diameterMm} mm hole`,
    });
  }
  return violations;
}

export function checkPattern(loadedHoles, rules = DEFAULT_CHARGE_RULES) {
  const violations = loadedHoles.flatMap(({ hole, column }) =>
    checkHoleCharge(hole, column, rules),
  );
  const byRule = violations.reduce((tally, violation) => {
    tally[violation.rule] = (tally[violation.rule] ?? 0) + 1;
    return tally;
  }, {});
  return {
    valid: violations.length === 0,
    violations,
    byRule,
    holesWithViolations: new Set(violations.map((violation) => violation.holeNumber)).size,
  };
}
