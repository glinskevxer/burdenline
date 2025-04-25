/**
 * A seeded random source.
 *
 * Anything in this codebase that samples has to be repeatable: a scatter
 * simulation that gives a different worst case every time it runs cannot be put
 * in front of a regulator, and a fixture that generates different holes each run
 * makes a failing test impossible to read. Math.random is never used for these.
 */

export function mulberry32(seed) {
  if (!Number.isInteger(seed)) {
    throw new TypeError('a seed has to be a whole number');
  }
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRandom(seed = 1) {
  const next = mulberry32(seed);
  return {
    next,
    between(low, high) {
      if (high < low) {
        throw new RangeError('the range is the wrong way round');
      }
      return low + next() * (high - low);
    },
    integer(low, high) {
      if (!Number.isInteger(low) || !Number.isInteger(high)) {
        throw new TypeError('an integer range needs whole bounds');
      }
      if (high < low) {
        throw new RangeError('the range is the wrong way round');
      }
      return low + Math.floor(next() * (high - low + 1));
    },
    /** Box Muller, which gives a normal deviate from two uniform ones. */
    normal(mean = 0, deviation = 1) {
      const first = Math.max(next(), Number.EPSILON);
      const second = next();
      return mean + deviation * Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
    },
    pick(items) {
      if (!Array.isArray(items) || items.length === 0) {
        throw new RangeError('there is nothing to pick from');
      }
      return items[Math.floor(next() * items.length)];
    },
  };
}

/** A percentile from a sample, by linear interpolation between the two nearest. */
export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError('a percentile needs at least one value');
  }
  if (!(fraction >= 0 && fraction <= 1)) {
    throw new RangeError('a percentile runs from 0 to 1');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
