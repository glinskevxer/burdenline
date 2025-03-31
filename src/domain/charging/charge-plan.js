/**
 * Turning a drilled pattern into a load sheet.
 *
 * The designer sets a target for how much explosive goes into each cubic metre
 * of rock. This works back from that: how much product that is for the hole, how
 * long a column that makes, whether it leaves enough hole for stemming, and if
 * it does not, what has to give. Wet holes take a different product from dry
 * ones and holes with a cavity in them get decked, so the plan is per hole and
 * not per pattern, even when every hole comes out the same.
 */

import { ValidationError, RuleViolationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';
import { buildColumn, deckLengthM } from './deck.js';
import { kgPerMetre, selectForHole, isBulk, WATER_RESISTANCE } from './products.js';
import { DEFAULT_CHARGE_RULES, minimumStemmingM, checkHoleCharge } from './rules.js';

/**
 * The least product that will do the job. Emulsion goes in where the hole needs
 * it and nowhere else, because it costs roughly twice what anfo costs and a
 * pattern of two hundred holes loaded on the safe side is real money.
 */
export function chooseProduct(hole, catalogue) {
  const options = selectForHole(catalogue, hole)
    .slice()
    .sort((a, b) => {
      const resistance =
        WATER_RESISTANCE.indexOf(a.waterResistance) - WATER_RESISTANCE.indexOf(b.waterResistance);
      return resistance !== 0
        ? resistance
        : (b.relativeWeightStrength ?? 0) - (a.relativeWeightStrength ?? 0);
    });
  if (options.length === 0) {
    throw new RuleViolationError(
      `nothing in the catalogue can be loaded into hole ${hole.holeNumber}`,
      [
        {
          rule: 'product.none_suitable',
          holeNumber: hole.holeNumber,
          message: `no product suits a ${hole.condition ?? 'dry'} hole at ${hole.diameterMm} mm`,
        },
      ],
    );
  }
  return options[0];
}

/**
 * Mass of explosive a hole should take to hit the target powder factor, which is
 * kilograms per cubic metre of the rock the hole is responsible for.
 */
export function targetMassKg({ burdenM, spacingM, benchHeightM, powderFactorKgM3 }) {
  for (const [name, value] of Object.entries({
    burdenM,
    spacingM,
    benchHeightM,
    powderFactorKgM3,
  })) {
    if (!(value > 0)) {
      throw new ValidationError(`${name} has to be positive to work a charge out`, [
        { path: name, message: 'must be greater than zero', kind: 'range' },
      ]);
    }
  }
  return roundTo(burdenM * spacingM * benchHeightM * powderFactorKgM3, 3);
}

/**
 * Plan one hole. When the target charge will not fit under the stemming the
 * column is cut back to what will fit and the shortfall is reported, because
 * quietly shortening the stemming is how a hole blows out.
 */
export function planHole(hole, options) {
  const rules = options.rules ?? DEFAULT_CHARGE_RULES;
  const product = options.product ?? chooseProduct(hole, options.catalogue ?? []);
  if (!isBulk(product) && product.kind !== 'packaged_emulsion') {
    throw new ValidationError(`${product.code} cannot fill a column`, [
      { path: 'product', message: 'expected a bulk or packaged product', kind: 'unsupported' },
    ]);
  }
  const holeLengthM = hole.drilledDepthM ?? hole.designedDepthM;
  if (!(holeLengthM > 0)) {
    throw new ValidationError(`hole ${hole.holeNumber} has no depth to load`, [
      { path: 'drilledDepthM', message: 'the hole has not been drilled', kind: 'missing' },
    ]);
  }
  const burden = hole.measuredBurdenM ?? hole.nominalBurdenM ?? options.burdenM;
  const stemmingM = options.stemmingM ?? minimumStemmingM(hole.diameterMm, burden, rules);
  const available = roundTo(holeLengthM - stemmingM, 3);
  if (available <= 0) {
    throw new RuleViolationError(`hole ${hole.holeNumber} is too short to load at all`, [
      {
        rule: 'charge.no_room',
        holeNumber: hole.holeNumber,
        message: `${holeLengthM} m of hole and ${stemmingM} m of stemming`,
      },
    ]);
  }

  const wanted =
    options.massKg ??
    targetMassKg({
      burdenM: burden,
      spacingM: options.spacingM,
      benchHeightM: options.benchHeightM,
      powderFactorKgM3: options.powderFactorKgM3,
    });
  const wantedLength = deckLengthM(product, hole.diameterMm, wanted);
  const length = Math.min(wantedLength, available);
  const shortfallKg = roundTo(
    Math.max(0, (wantedLength - length) * kgPerMetre(product, hole.diameterMm)),
    3,
  );

  const column = buildColumn({
    holeLengthM,
    diameterMm: hole.diameterMm,
    stemmingM,
    charges: [{ product, lengthM: roundTo(length, 3), primed: true }],
  });

  return {
    holeNumber: hole.holeNumber,
    productCode: product.code,
    column,
    wantedMassKg: wanted,
    loadedMassKg: column.totalMassKg,
    shortfallKg,
    stemmingM,
    violations: checkHoleCharge(
      { ...hole, nominalBurdenM: hole.nominalBurdenM ?? burden },
      column,
      rules,
    ),
  };
}

export function planPattern(holes, options) {
  if (!Array.isArray(holes) || holes.length === 0) {
    throw new ValidationError('there are no holes to load', [
      { path: 'holes', message: 'the pattern is empty', kind: 'missing' },
    ]);
  }
  const planned = [];
  const skipped = [];
  for (const hole of holes) {
    if (
      hole.condition === 'collapsed' ||
      hole.condition === 'lost' ||
      hole.status === 'abandoned'
    ) {
      skipped.push({ holeNumber: hole.holeNumber, reason: hole.condition ?? hole.status });
      continue;
    }
    planned.push(planHole(hole, options));
  }
  return summarise(planned, skipped, options);
}

function summarise(planned, skipped, options) {
  const totalMassKg = roundTo(
    planned.reduce((sum, item) => sum + item.loadedMassKg, 0),
    3,
  );
  const volumeM3 = roundTo(
    planned.length * (options.burdenM ?? 0) * (options.spacingM ?? 0) * (options.benchHeightM ?? 0),
    3,
  );
  const violations = planned.flatMap((item) => item.violations);
  const byProduct = planned.reduce((tally, item) => {
    tally[item.productCode] = roundTo((tally[item.productCode] ?? 0) + item.loadedMassKg, 3);
    return tally;
  }, {});
  return {
    holes: planned,
    skipped,
    totalMassKg,
    byProduct,
    volumeM3,
    achievedPowderFactorKgM3: volumeM3 > 0 ? roundTo(totalMassKg / volumeM3, 4) : null,
    shortfallKg: roundTo(
      planned.reduce((sum, item) => sum + item.shortfallKg, 0),
      3,
    ),
    violations,
    valid: violations.length === 0,
  };
}

/** The load sheet the crew works from, one line per hole in loading order. */
export function loadSheet(plan) {
  return plan.holes.map((item) => ({
    hole: item.holeNumber,
    product: item.productCode,
    charge_kg: item.loadedMassKg,
    charge_m: item.column.chargeLengthM,
    stemming_m: item.stemmingM,
    boosters: item.column.decks.reduce((sum, deck) => sum + (deck.boosterCount ?? 0), 0),
  }));
}
