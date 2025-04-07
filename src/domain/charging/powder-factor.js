/**
 * Powder factor and the energy behind it.
 *
 * Powder factor is kilograms of explosive per cubic metre of rock and it is the
 * number every quarry manager quotes, but on its own it compares badly across
 * products: a kilogram of emulsion and a kilogram of anfo do not do the same
 * work. The energy factor corrects for that by weighting the mass by relative
 * weight strength, and it is the number to use when a site changes product and
 * wants to know whether it has actually changed anything.
 */

import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';

/** What a rock type will usually take, in kilograms per cubic metre. */
export const POWDER_FACTOR_BANDS = Object.freeze({
  soft: { low: 0.15, high: 0.35 },
  medium: { low: 0.3, high: 0.55 },
  hard: { low: 0.45, high: 0.8 },
  very_hard: { low: 0.6, high: 1.1 },
});

export function powderFactor({ massKg, volumeM3 }) {
  requirePositive(volumeM3, 'volumeM3');
  requireNonNegative(massKg, 'massKg');
  return roundTo(massKg / volumeM3, 4);
}

export function specificCharge({ massKg, tonnes }) {
  requirePositive(tonnes, 'tonnes');
  requireNonNegative(massKg, 'massKg');
  return roundTo(massKg / tonnes, 4);
}

/** Mass expressed as the anfo that would carry the same energy. */
export function anfoEquivalentKg(loads) {
  return roundTo(
    loads.reduce((sum, load) => {
      const strength = load.relativeWeightStrength ?? 100;
      requirePositive(strength, 'relativeWeightStrength');
      return sum + (load.massKg * strength) / 100;
    }, 0),
    3,
  );
}

export function energyFactor({ loads, volumeM3 }) {
  requirePositive(volumeM3, 'volumeM3');
  return roundTo(anfoEquivalentKg(loads) / volumeM3, 4);
}

export function assess(factor, rockType = 'medium') {
  const band = POWDER_FACTOR_BANDS[rockType];
  if (!band) {
    throw new ValidationError(`${rockType} is not a rock band`, [
      {
        path: 'rockType',
        message: `expected one of ${Object.keys(POWDER_FACTOR_BANDS).join(', ')}`,
        kind: 'enum',
      },
    ]);
  }
  if (factor < band.low) {
    return { verdict: 'light', band, message: 'the pattern is under charged for this rock' };
  }
  if (factor > band.high) {
    return { verdict: 'heavy', band, message: 'the pattern is over charged for this rock' };
  }
  return { verdict: 'normal', band, message: 'the charge suits the rock' };
}

/**
 * Powder factor row by row. The front row breaks against a free face and the
 * back rows do not, so a flat powder factor across the pattern usually means the
 * front row is over charged, which is where flyrock comes from.
 */
export function byRow(loadedHoles, { burdenM, spacingM, benchHeightM }) {
  const volumePerHole = burdenM * spacingM * benchHeightM;
  requirePositive(volumePerHole, 'volume per hole');
  const rows = new Map();
  for (const hole of loadedHoles) {
    const row = hole.rowNumber ?? 1;
    const current = rows.get(row) ?? { rowNumber: row, holeCount: 0, massKg: 0 };
    current.holeCount += 1;
    current.massKg = roundTo(current.massKg + hole.massKg, 3);
    rows.set(row, current);
  }
  return [...rows.values()]
    .sort((a, b) => a.rowNumber - b.rowNumber)
    .map((row) => ({
      ...row,
      volumeM3: roundTo(row.holeCount * volumePerHole, 3),
      powderFactorKgM3: roundTo(row.massKg / (row.holeCount * volumePerHole), 4),
    }));
}

/** How evenly the charge is spread. A spread over about a fifth is worth a look. */
export function distribution(rows) {
  if (rows.length === 0) {
    return { spread: null, front: null, back: null, even: true };
  }
  const factors = rows.map((row) => row.powderFactorKgM3);
  const lowest = Math.min(...factors);
  const highest = Math.max(...factors);
  const mean = factors.reduce((sum, factor) => sum + factor, 0) / factors.length;
  return {
    spread: roundTo(mean === 0 ? 0 : (highest - lowest) / mean, 4),
    front: rows[0].powderFactorKgM3,
    back: rows.at(-1).powderFactorKgM3,
    mean: roundTo(mean, 4),
    even: mean === 0 ? true : (highest - lowest) / mean <= 0.2,
  };
}

function requirePositive(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`${name} has to be positive`, [
      { path: name, message: 'must be greater than zero', kind: 'range' },
    ]);
  }
}

function requireNonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${name} cannot be negative`, [
      { path: name, message: 'must be zero or more', kind: 'range' },
    ]);
  }
}
