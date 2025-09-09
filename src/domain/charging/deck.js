/**
 * The charge column in a hole.
 *
 * A column is built from the bottom of the hole upward, because that is the
 * order it is loaded: primer and bottom charge first, then the column charge,
 * then whatever inert decking the design calls for, then stemming at the top.
 * Positions are held as distances from the toe so that a hole drilled a little
 * short does not silently move every deck; the loader works off the toe with a
 * tape and so does this.
 */

import { ValidationError } from '../../lib/errors.js';
import { requirePositive } from '../../lib/guards.js';
import { roundTo } from '../../lib/units.js';
import { kgPerMetre, isBulk } from './products.js';

export const DECK_KINDS = ['charge', 'stemming', 'air', 'inert'];

export function deckMassKg(product, diameterMm, lengthM) {
  requirePositive(lengthM, 'lengthM');
  return roundTo(kgPerMetre(product, diameterMm) * lengthM, 3);
}

export function deckLengthM(product, diameterMm, massKg) {
  requirePositive(massKg, 'massKg');
  const perMetre = kgPerMetre(product, diameterMm);
  return roundTo(massKg / perMetre, 3);
}

/**
 * Build the column. Each charge is given either a mass or a length and the other
 * is worked out; giving both is a mistake worth refusing, because the two
 * disagree the moment somebody edits one of them.
 */
export function buildColumn(input) {
  const { holeLengthM, diameterMm, stemmingM, charges } = input;
  requirePositive(holeLengthM, 'holeLengthM');
  requirePositive(diameterMm, 'diameterMm');
  if (typeof stemmingM !== 'number' || stemmingM < 0) {
    throw new ValidationError('stemming cannot be negative', [
      { path: 'stemmingM', message: 'must be zero or more', kind: 'range' },
    ]);
  }
  if (!Array.isArray(charges) || charges.length === 0) {
    throw new ValidationError('a column needs at least one charge', [
      { path: 'charges', message: 'no charge given', kind: 'missing' },
    ]);
  }

  const decks = [];
  let position = 0;
  for (const [index, charge] of charges.entries()) {
    if (charge.gapM) {
      requirePositive(charge.gapM, `charges.${index}.gapM`);
      decks.push(
        deck('inert', position, position + charge.gapM, {
          productCode: charge.gapProductCode ?? null,
        }),
      );
      position = roundTo(position + charge.gapM, 3);
    }
    const length = resolveLength(charge, diameterMm, index);
    const mass =
      charge.product && isBulk(charge.product)
        ? deckMassKg(charge.product, diameterMm, length)
        : roundTo(charge.massKg ?? 0, 3);
    decks.push(
      deck('charge', position, position + length, {
        productCode: charge.product?.code ?? charge.productCode ?? null,
        massKg: mass,
        primed: charge.primed ?? index === 0,
        boosterCount: charge.boosterCount ?? ((charge.primed ?? index === 0) ? 1 : 0),
      }),
    );
    position = roundTo(position + length, 3);
  }

  const charged = position;
  const remaining = roundTo(holeLengthM - charged, 3);
  if (remaining < 0) {
    throw new ValidationError('the charges are longer than the hole', [
      {
        path: 'charges',
        message: `${roundTo(charged, 2)} m of column in a ${holeLengthM} m hole`,
        kind: 'range',
      },
    ]);
  }
  if (stemmingM > remaining + 1e-9) {
    throw new ValidationError('there is not enough hole left for the stemming', [
      {
        path: 'stemmingM',
        message: `${stemmingM} m asked for and ${remaining} m left`,
        kind: 'range',
      },
    ]);
  }
  if (remaining > stemmingM + 1e-9) {
    decks.push(deck('air', position, roundTo(holeLengthM - stemmingM, 3), {}));
  }
  if (stemmingM > 0) {
    decks.push(deck('stemming', roundTo(holeLengthM - stemmingM, 3), holeLengthM, {}));
  }

  return {
    holeLengthM: roundTo(holeLengthM, 3),
    diameterMm,
    decks,
    chargeLengthM: roundTo(
      decks.filter((d) => d.kind === 'charge').reduce((s, d) => s + d.lengthM, 0),
      3,
    ),
    totalMassKg: roundTo(
      decks.reduce((sum, item) => sum + (item.massKg ?? 0), 0),
      3,
    ),
    stemmingM: roundTo(stemmingM, 3),
    airGapM: roundTo(
      decks.filter((d) => d.kind === 'air').reduce((s, d) => s + d.lengthM, 0),
      3,
    ),
  };
}

/** Where a deck sits measured down from the collar, which is what the loader tape reads. */
export function depthsFromCollar(column) {
  return column.decks.map((item) => ({
    ...item,
    fromCollarM: roundTo(column.holeLengthM - item.toToeM, 3),
    toCollarM: roundTo(column.holeLengthM - item.fromToeM, 3),
  }));
}

export function validateColumn(column) {
  const violations = [];
  const sorted = [...column.decks].sort((a, b) => a.fromToeM - b.fromToeM);
  let expected = 0;
  for (const item of sorted) {
    if (item.fromToeM > expected + 1e-6) {
      violations.push({
        rule: 'column.gap',
        message: `nothing between ${expected} m and ${item.fromToeM} m off the toe`,
      });
    }
    if (item.fromToeM < expected - 1e-6) {
      violations.push({
        rule: 'column.overlap',
        message: `two decks overlap at ${item.fromToeM} m off the toe`,
      });
    }
    if (item.lengthM <= 0) {
      violations.push({ rule: 'column.empty_deck', message: `a ${item.kind} deck has no length` });
    }
    expected = roundTo(Math.max(expected, item.toToeM), 3);
  }
  if (Math.abs(expected - column.holeLengthM) > 1e-6) {
    violations.push({
      rule: 'column.short',
      message: `the column accounts for ${expected} m of a ${column.holeLengthM} m hole`,
    });
  }
  if (!column.decks.some((item) => item.kind === 'charge' && item.primed)) {
    violations.push({ rule: 'column.unprimed', message: 'no deck in the column is primed' });
  }
  return { valid: violations.length === 0, violations };
}

function deck(kind, fromToeM, toToeM, extra) {
  return {
    kind,
    fromToeM: roundTo(fromToeM, 3),
    toToeM: roundTo(toToeM, 3),
    lengthM: roundTo(toToeM - fromToeM, 3),
    productCode: null,
    massKg: 0,
    primed: false,
    boosterCount: 0,
    ...extra,
  };
}

function resolveLength(charge, diameterMm, index) {
  const hasLength = typeof charge.lengthM === 'number';
  const hasMass = typeof charge.massKg === 'number';
  if (hasLength && hasMass) {
    throw new ValidationError('give a charge a mass or a length, not both', [
      { path: `charges.${index}`, message: 'mass and length both given', kind: 'conflict' },
    ]);
  }
  if (hasLength) {
    requirePositive(charge.lengthM, `charges.${index}.lengthM`);
    return roundTo(charge.lengthM, 3);
  }
  if (hasMass) {
    if (!charge.product) {
      throw new ValidationError('a charge given by mass needs a product to convert it', [
        { path: `charges.${index}.product`, message: 'no product', kind: 'missing' },
      ]);
    }
    return deckLengthM(charge.product, diameterMm, charge.massKg);
  }
  throw new ValidationError('a charge needs a mass or a length', [
    { path: `charges.${index}`, message: 'neither mass nor length given', kind: 'missing' },
  ]);
}
