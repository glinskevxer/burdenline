import { describe, it, expect } from 'vitest';
import {
  isFiniteNumber,
  requireFinite,
  requirePositive,
  requireNonNegative,
  requireInRange,
  requireWholeNumber,
  requireOneOf,
  pick,
} from '../../src/lib/guards.js';
import { ValidationError } from '../../src/lib/errors.js';

describe('isFiniteNumber', () => {
  it('takes a number and nothing else', () => {
    expect(isFiniteNumber(4)).toBe(true);
    expect(isFiniteNumber('4')).toBe(false);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
  });
});

describe('requireFinite', () => {
  it('hands the value back when it passes', () => {
    expect(requireFinite(4.2, 'burdenM')).toBe(4.2);
  });

  it('names the argument in the issue', () => {
    try {
      requireFinite('4', 'burdenM');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.issues[0].path).toBe('burdenM');
      expect(error.issues[0].kind).toBe('type');
    }
  });
});

describe('requirePositive', () => {
  it('takes anything above zero', () => {
    expect(requirePositive(0.001, 'x')).toBe(0.001);
  });

  it('refuses zero and below', () => {
    expect(() => requirePositive(0, 'x')).toThrow(ValidationError);
    expect(() => requirePositive(-1, 'x')).toThrow(ValidationError);
  });

  it('refuses a numeric string, which used to slip through in one module', () => {
    expect(() => requirePositive('5', 'x')).toThrow(ValidationError);
  });
});

describe('requireNonNegative', () => {
  it('takes zero', () => {
    expect(requireNonNegative(0, 'x')).toBe(0);
  });

  it('refuses below zero', () => {
    expect(() => requireNonNegative(-0.5, 'x')).toThrow(ValidationError);
  });
});

describe('requireInRange', () => {
  it('takes both ends of the range', () => {
    expect(requireInRange(0, 'x', 0, 10)).toBe(0);
    expect(requireInRange(10, 'x', 0, 10)).toBe(10);
  });

  it('refuses outside it and says what the range was', () => {
    try {
      requireInRange(11, 'inclinationDeg', 0, 10);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.message).toContain('0 to 10');
    }
  });
});

describe('requireWholeNumber', () => {
  it('takes a whole number at or above the floor', () => {
    expect(requireWholeNumber(1, 'holeCount')).toBe(1);
    expect(requireWholeNumber(0, 'sequence', { minimum: 0 })).toBe(0);
  });

  it('refuses a fraction or a number under the floor', () => {
    expect(() => requireWholeNumber(1.5, 'holeCount')).toThrow(ValidationError);
    expect(() => requireWholeNumber(0, 'holeCount')).toThrow(ValidationError);
  });
});

describe('requireOneOf', () => {
  it('takes a value in the list', () => {
    expect(requireOneOf('wet', 'condition', ['dry', 'wet'])).toBe('wet');
  });

  it('lists what was allowed', () => {
    try {
      requireOneOf('soggy', 'condition', ['dry', 'wet']);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.issues[0].message).toBe('expected one of dry, wet');
    }
  });
});

describe('pick', () => {
  it('takes only the keys it is given', () => {
    expect(pick({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  it('drops anything undefined', () => {
    expect(pick({ a: undefined, b: 2 }, ['a', 'b'])).toEqual({ b: 2 });
  });

  it('keeps null, which is how a field is cleared', () => {
    expect(pick({ a: null }, ['a'])).toEqual({ a: null });
  });

  it('takes a missing source without complaining', () => {
    expect(pick(undefined, ['a'])).toEqual({});
  });
});
