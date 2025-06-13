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
import { collector, byRule } from '../violations.js';

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
  const found = collector();
  const burden = hole.measuredBurdenM ?? hole.nominalBurdenM;
  const diameter = column.diameterMm ?? hole.diameterMm;
  const at = { holeNumber: hole.holeNumber };

  if (burden !== undefined && burden !== null) {
    const floor = minimumStemmingM(diameter, burden, rules);
    found.atLeast(
      column.stemmingM,
      floor,
      'stemming.minimum',
      `stemming of ${column.stemmingM} m is under the ${floor} m this hole needs`,
      at,
    );
    found.atMost(
      column.stemmingM,
      maximumStemmingM(burden, rules),
      'stemming.maximum',
      `stemming of ${column.stemmingM} m will leave the collar rock standing`,
      at,
    );
    found.atLeast(
      burden,
      rules.minimumBurdenM,
      'burden.minimum',
      `a burden of ${burden} m is under the ${rules.minimumBurdenM} m floor`,
      at,
    );
    if (hole.nominalBurdenM) {
      found.atMost(
        burden,
        roundTo(hole.nominalBurdenM * rules.maximumBurdenRatio, 3),
        'burden.excessive',
        `a measured burden of ${burden} m is well past the ${hole.nominalBurdenM} m design`,
        at,
      );
    }
  }

  const chargeDecks = column.decks.filter((deck) => deck.kind === 'charge');
  found.addIf(chargeDecks.length === 0, 'charge.missing', 'the hole has no charge in it', at);
  for (const deck of chargeDecks) {
    found.atLeast(
      deck.lengthM,
      rules.minimumChargeLengthM,
      'charge.deck_too_short',
      `a charge deck of ${deck.lengthM} m is too short to fire reliably`,
      at,
    );
    const longest = roundTo((rules.maximumChargeLengthDiameters * diameter) / 1000, 3);
    found.atMost(
      deck.lengthM,
      longest,
      'charge.deck_too_long',
      `a charge deck of ${deck.lengthM} m runs past ${longest} m`,
      at,
    );
    found.addIf(
      deck.primed && deck.boosterCount < rules.minimumBoosterPerDeck,
      'primer.missing',
      'a primed deck has no booster in it',
      at,
    );
    found.atMost(
      deck.boosterCount,
      rules.maximumBoosterPerDeck,
      'primer.excessive',
      `${deck.boosterCount} boosters in one deck`,
      at,
    );
  }
  for (const deck of column.decks.filter((item) => item.kind === 'inert')) {
    found.atLeast(
      deck.lengthM,
      rules.minimumDeckSeparationM,
      'deck.separation',
      `${deck.lengthM} m between decks will let one shoot the other out`,
      at,
    );
  }
  found.addIf(
    chargeDecks.length > 0 && !chargeDecks.some((deck) => deck.primed),
    'primer.none_in_hole',
    'nothing in the hole is primed',
    at,
  );
  return found.all();
}

/** Stemming material has to be angular chippings of about a tenth of the diameter. */
export function checkStemmingMaterial(diameterMm, materialSizeMm, rules = DEFAULT_CHARGE_RULES) {
  return collector()
    .atLeast(
      materialSizeMm,
      rules.minimumStemmingSizeMm,
      'stemming.material_fine',
      `${materialSizeMm} mm stemming is too fine to lock in the collar`,
    )
    .atMost(
      materialSizeMm,
      diameterMm * rules.maximumStemmingSizeDiameterRatio,
      'stemming.material_coarse',
      `${materialSizeMm} mm stemming will bridge in a ${diameterMm} mm hole`,
    )
    .all();
}

export function checkPattern(loadedHoles, rules = DEFAULT_CHARGE_RULES) {
  const violations = loadedHoles.flatMap(({ hole, column }) =>
    checkHoleCharge(hole, column, rules),
  );
  return {
    valid: violations.length === 0,
    violations,
    byRule: byRule(violations),
    holesWithViolations: new Set(violations.map((item) => item.holeNumber)).size,
  };
}
