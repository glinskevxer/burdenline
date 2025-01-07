/**
 * Unit handling for the blast design side of the system.
 *
 * Everything stored in the database is metric and in base units: metres for
 * length, kilograms for mass, kilograms per cubic metre for density, millimetres
 * per second for peak particle velocity. Conversions live here so that no other
 * module carries a bare magic factor, and so that the imperial output the older
 * seismograph vendors still emit has exactly one place to be normalised.
 */

const MM_PER_M = 1000;
const FEET_PER_M = 3.280839895013123;
const INCH_PER_MM = 0.03937007874015748;
const KG_PER_TONNE = 1000;
const LB_PER_KG = 2.204622621848776;
const AIRBLAST_REFERENCE_PA = 2e-5;

export function mmToMetres(mm) {
  requireFinite(mm, 'mm');
  return mm / MM_PER_M;
}

export function metresToMm(metres) {
  requireFinite(metres, 'metres');
  return metres * MM_PER_M;
}

export function feetToMetres(feet) {
  requireFinite(feet, 'feet');
  return feet / FEET_PER_M;
}

export function metresToFeet(metres) {
  requireFinite(metres, 'metres');
  return metres * FEET_PER_M;
}

export function tonnesToKg(tonnes) {
  requireFinite(tonnes, 'tonnes');
  return tonnes * KG_PER_TONNE;
}

export function kgToTonnes(kg) {
  requireFinite(kg, 'kg');
  return kg / KG_PER_TONNE;
}

export function poundsToKg(pounds) {
  requireFinite(pounds, 'pounds');
  return pounds / LB_PER_KG;
}

export function kgToPounds(kg) {
  requireFinite(kg, 'kg');
  return kg * LB_PER_KG;
}

/**
 * Explosive product data sheets quote density in grams per cubic centimetre.
 * The charge column math wants kilograms per cubic metre.
 */
export function gramsPerCcToKgPerM3(gramsPerCc) {
  requireFinite(gramsPerCc, 'gramsPerCc');
  return gramsPerCc * 1000;
}

export function kgPerM3ToGramsPerCc(kgPerM3) {
  requireFinite(kgPerM3, 'kgPerM3');
  return kgPerM3 / 1000;
}

/** Peak particle velocity as reported by North American monitors. */
export function inchesPerSecondToMmPerSecond(ips) {
  requireFinite(ips, 'ips');
  return ips / INCH_PER_MM;
}

export function mmPerSecondToInchesPerSecond(mms) {
  requireFinite(mms, 'mms');
  return mms * INCH_PER_MM;
}

/** Airblast overpressure in pascals to the linear decibel scale monitors report. */
export function pascalsToDecibels(pascals) {
  requireFinite(pascals, 'pascals');
  if (pascals <= 0) {
    throw new RangeError('overpressure must be greater than zero to express in decibels');
  }
  return 20 * Math.log10(pascals / AIRBLAST_REFERENCE_PA);
}

export function decibelsToPascals(db) {
  requireFinite(db, 'db');
  return AIRBLAST_REFERENCE_PA * 10 ** (db / 20);
}

/**
 * Round half away from zero at a fixed number of decimals. Javascript's own
 * rounding is half up, which biases a column of charge masses upward once you
 * sum a few hundred of them.
 */
export function roundTo(value, decimals = 3) {
  requireFinite(value, 'value');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new RangeError('decimals must be an integer between 0 and 12');
  }
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / factor;
}

/** Round up to the next step. Used for ordering whole cartons of detonators. */
export function ceilToStep(value, step) {
  requireFinite(value, 'value');
  requireFinite(step, 'step');
  if (step <= 0) {
    throw new RangeError('step must be greater than zero');
  }
  return Math.ceil(roundTo(value / step, 9)) * step;
}

export function clamp(value, min, max) {
  requireFinite(value, 'value');
  requireFinite(min, 'min');
  requireFinite(max, 'max');
  if (min > max) {
    throw new RangeError('min must not exceed max');
  }
  return Math.min(Math.max(value, min), max);
}

function requireFinite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

export const __testing = { requireFinite };
