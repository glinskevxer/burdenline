/**
 * Argument guards.
 *
 * Nine modules had grown their own private `requirePositive`, and they had
 * drifted: three threw TypeError, four threw a ValidationError, one accepted
 * zero and one accepted a numeric string. That is exactly the kind of difference
 * that turns into a bug report about the same bad input being rejected in one
 * screen and accepted in another, so they are one function now.
 *
 * The rule they all follow: a value that is structurally wrong for a domain
 * quantity is a ValidationError with the field named, because it nearly always
 * came in over HTTP or off a spreadsheet and the caller has to be told which
 * field it was.
 */

import { ValidationError } from './errors.js';

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function requireFinite(value, name) {
  if (!isFiniteNumber(value)) {
    throw new ValidationError(`${name} has to be a finite number`, [
      { path: name, message: 'expected a finite number', kind: 'type' },
    ]);
  }
  return value;
}

export function requirePositive(value, name) {
  requireFinite(value, name);
  if (value <= 0) {
    throw new ValidationError(`${name} has to be positive`, [
      { path: name, message: 'must be greater than zero', kind: 'range' },
    ]);
  }
  return value;
}

export function requireNonNegative(value, name) {
  requireFinite(value, name);
  if (value < 0) {
    throw new ValidationError(`${name} cannot be negative`, [
      { path: name, message: 'must be zero or more', kind: 'range' },
    ]);
  }
  return value;
}

export function requireInRange(value, name, low, high) {
  requireFinite(value, name);
  if (value < low || value > high) {
    throw new ValidationError(`${name} is outside ${low} to ${high}`, [
      { path: name, message: `expected between ${low} and ${high}`, kind: 'range' },
    ]);
  }
  return value;
}

export function requireWholeNumber(value, name, { minimum = 1 } = {}) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new ValidationError(`${name} has to be a whole number of at least ${minimum}`, [
      { path: name, message: 'expected a whole number', kind: 'type' },
    ]);
  }
  return value;
}

export function requireOneOf(value, name, allowed) {
  if (!allowed.includes(value)) {
    throw new ValidationError(`${value} is not a ${name}`, [
      { path: name, message: `expected one of ${allowed.join(', ')}`, kind: 'enum' },
    ]);
  }
  return value;
}

/** Copy only the keys a caller is allowed to set, dropping anything undefined. */
export function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}
