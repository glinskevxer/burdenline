import { describe, it, expect } from 'vitest';
import { mulberry32, createRandom, percentile } from '../../src/lib/random.js';

describe('mulberry32', () => {
  it('gives the same stream for the same seed', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('gives a different stream for a different seed', () => {
    expect(mulberry32(7)()).not.toBe(mulberry32(8)());
  });

  it('stays inside the unit interval', () => {
    const next = mulberry32(3);
    for (let i = 0; i < 500; i += 1) {
      const value = next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('refuses a seed that is not whole', () => {
    expect(() => mulberry32(1.5)).toThrow(TypeError);
  });
});

describe('createRandom', () => {
  it('draws inside a range', () => {
    const random = createRandom(11);
    for (let i = 0; i < 200; i += 1) {
      const value = random.between(10, 20);
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThanOrEqual(20);
    }
  });

  it('draws whole numbers inclusive of both ends', () => {
    const random = createRandom(5);
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) {
      seen.add(random.integer(1, 3));
    }
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  it('refuses a backwards range', () => {
    const random = createRandom(1);
    expect(() => random.between(10, 1)).toThrow(RangeError);
    expect(() => random.integer(10, 1)).toThrow(RangeError);
    expect(() => random.integer(1.5, 4)).toThrow(TypeError);
  });

  it('draws normal deviates around the mean', () => {
    const random = createRandom(99);
    const sample = Array.from({ length: 4000 }, () => random.normal(100, 5));
    const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;
    expect(mean).toBeGreaterThan(99);
    expect(mean).toBeLessThan(101);
  });

  it('picks from a list and refuses an empty one', () => {
    const random = createRandom(2);
    expect(['a', 'b', 'c']).toContain(random.pick(['a', 'b', 'c']));
    expect(() => random.pick([])).toThrow(RangeError);
  });
});

describe('percentile', () => {
  it('reads the middle of an odd sample', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  it('interpolates between two values', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it('reads both ends', () => {
    expect(percentile([4, 1, 9], 0)).toBe(1);
    expect(percentile([4, 1, 9], 1)).toBe(9);
  });

  it('refuses an empty sample or a fraction outside the range', () => {
    expect(() => percentile([], 0.5)).toThrow(RangeError);
    expect(() => percentile([1], 1.4)).toThrow(RangeError);
  });
});
