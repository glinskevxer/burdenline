/**
 * What a shot cost.
 *
 * Explosive, detonators, drilling, the crew, and whatever secondary breaking the
 * muckpile needed afterwards. The last of those is the one that makes the number
 * worth having: a pattern pulled out to save drilling looks cheaper right up
 * until somebody spends two days with a hammer on the oversize, and a cost per
 * tonne that stops at the explosive will never show it.
 *
 * Prices are effective dated. A shot fired in March is costed at the March
 * price, not at whatever the supplier charges now, because the whole point is to
 * compare shots against each other.
 */

import { roundTo } from '../../lib/units.js';
import { requirePositive, requireNonNegative } from '../../lib/guards.js';
import { ValidationError } from '../../lib/errors.js';

export const COST_KINDS = [
  'explosive',
  'accessories',
  'drilling',
  'labour',
  'secondary_breaking',
  'survey',
  'monitoring',
  'overhead',
];

/** The price in force on a date, or nothing if the product was not priced then. */
export function priceOn(prices, productCode, onDate) {
  const candidates = prices
    .filter((price) => price.productCode === productCode)
    .filter((price) => price.effectiveFrom <= onDate)
    .filter((price) => !price.effectiveTo || price.effectiveTo > onDate)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return candidates[0] ?? null;
}

export function rateOn(rates, kind, onDate) {
  const candidates = rates
    .filter((rate) => rate.kind === kind)
    .filter((rate) => rate.effectiveFrom <= onDate)
    .filter((rate) => !rate.effectiveTo || rate.effectiveTo > onDate)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return candidates[0] ?? null;
}

/** Cost of what was consumed, one line per product, at the price on the day. */
export function explosiveCost({ consumption, prices, onDate }) {
  const lines = [];
  const unpriced = [];
  for (const item of consumption) {
    const price = priceOn(prices, item.productCode, onDate);
    if (!price) {
      unpriced.push(item.productCode);
      continue;
    }
    lines.push({
      productCode: item.productCode,
      quantity: item.quantity,
      unit: item.unit ?? price.unit,
      pricePerUnit: price.pricePerUnit,
      cost: roundTo(item.quantity * price.pricePerUnit, 2),
      currency: price.currency ?? 'EUR',
    });
  }
  return {
    lines,
    unpriced,
    total: roundTo(
      lines.reduce((sum, line) => sum + line.cost, 0),
      2,
    ),
  };
}

export function drillingCost({ metresDrilled, rates, onDate }) {
  requireNonNegative(metresDrilled, 'metresDrilled');
  const rate = rateOn(rates, 'drilling', onDate);
  if (!rate) {
    return { metresDrilled, ratePerMetre: null, total: 0, priced: false };
  }
  return {
    metresDrilled,
    ratePerMetre: rate.rate,
    total: roundTo(metresDrilled * rate.rate, 2),
    priced: true,
  };
}

export function fixedCost({ kind, quantity, rates, onDate }) {
  if (!COST_KINDS.includes(kind)) {
    throw new ValidationError(`${kind} is not something this costs`, [
      { path: 'kind', message: `expected one of ${COST_KINDS.join(', ')}`, kind: 'enum' },
    ]);
  }
  const rate = rateOn(rates, kind, onDate);
  if (!rate) {
    return { kind, quantity, rate: null, total: 0, priced: false };
  }
  return { kind, quantity, rate: rate.rate, total: roundTo(quantity * rate.rate, 2), priced: true };
}

/**
 * The whole cost of a shot and the two numbers a manager actually reads: cost
 * per tonne broken and cost per cubic metre.
 */
export function costBlast({
  consumption = [],
  prices = [],
  rates = [],
  metresDrilled = 0,
  labourHours = 0,
  secondaryBreakingHours = 0,
  surveyHours = 0,
  tonnes,
  volumeM3,
  onDate,
  currency = 'EUR',
}) {
  if (!onDate) {
    throw new ValidationError('a cost has to be worked out as at a date', [
      { path: 'onDate', message: 'no date given', kind: 'missing' },
    ]);
  }
  const explosive = explosiveCost({ consumption, prices, onDate });
  const drilling = drillingCost({ metresDrilled, rates, onDate });
  const labour = fixedCost({ kind: 'labour', quantity: labourHours, rates, onDate });
  const secondary = fixedCost({
    kind: 'secondary_breaking',
    quantity: secondaryBreakingHours,
    rates,
    onDate,
  });
  const survey = fixedCost({ kind: 'survey', quantity: surveyHours, rates, onDate });

  const parts = {
    explosive: explosive.total,
    drilling: drilling.total,
    labour: labour.total,
    secondary_breaking: secondary.total,
    survey: survey.total,
  };
  const total = roundTo(
    Object.values(parts).reduce((sum, value) => sum + value, 0),
    2,
  );

  return {
    onDate,
    currency,
    parts,
    lines: explosive.lines,
    unpricedProducts: explosive.unpriced,
    total,
    perTonne: tonnes ? roundTo(total / requirePositive(tonnes, 'tonnes'), 4) : null,
    perCubicMetre: volumeM3 ? roundTo(total / requirePositive(volumeM3, 'volumeM3'), 4) : null,
    share: Object.fromEntries(
      Object.entries(parts).map(([kind, value]) => [
        kind,
        total === 0 ? 0 : roundTo(value / total, 4),
      ]),
    ),
  };
}

/** Two shots side by side, which is the only way any of this is used. */
export function compareCosts(first, second) {
  const difference = roundTo(second.total - first.total, 2);
  return {
    difference,
    perTonneDifference:
      first.perTonne === null || second.perTonne === null
        ? null
        : roundTo(second.perTonne - first.perTonne, 4),
    cheaper: difference < 0 ? 'second' : difference > 0 ? 'first' : 'the same',
    byKind: Object.fromEntries(
      Object.keys(first.parts).map((kind) => [
        kind,
        roundTo((second.parts[kind] ?? 0) - (first.parts[kind] ?? 0), 2),
      ]),
    ),
  };
}
