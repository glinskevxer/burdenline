import { describe, it, expect } from 'vitest';
import {
  axisPointAtLevel,
  faceSlice,
  burdenAtLevel,
  burdenProfile,
  minimumBurden,
  maximumBurden,
  describeBurden,
  faceAngle,
} from '../../../src/domain/geometry/profile.js';
import { ValidationError } from '../../../src/lib/errors.js';

const collar = { easting: 1000, northing: 2000, level: 84 };

const vertical = { collar, benchHeightM: 15, inclinationDeg: 0, bearingDeg: 0 };

/** A flat face three metres in front of the hole, scanned every metre down. */
function flatFace(distance = 3, from = 84, to = 69) {
  const points = [];
  for (let level = from; level >= to; level -= 1) {
    for (const northing of [1998, 2000, 2002]) {
      points.push({ easting: collar.easting - distance, northing, level });
    }
  }
  return points;
}

describe('axisPointAtLevel', () => {
  it('stays under the collar for a vertical hole', () => {
    const axis = axisPointAtLevel(vertical, 70);
    expect(axis.easting).toBe(collar.easting);
    expect(axis.northing).toBe(collar.northing);
    expect(axis.level).toBe(70);
  });

  it('walks out along the bearing as an angled hole drops', () => {
    const angled = { collar, inclinationDeg: 20, bearingDeg: 270 };
    const axis = axisPointAtLevel(angled, 74);
    expect(axis.easting).toBeLessThan(collar.easting);
    expect(collar.easting - axis.easting).toBeCloseTo(10 * Math.tan((20 * Math.PI) / 180), 6);
  });

  it('refuses a level above the collar', () => {
    expect(() => axisPointAtLevel(vertical, 90)).toThrow(ValidationError);
  });
});

describe('slicing the scan', () => {
  it('takes the points within the band', () => {
    expect(faceSlice(flatFace(), 75, 0.5)).toHaveLength(3);
    expect(faceSlice(flatFace(), 75, 1.5)).toHaveLength(9);
  });

  it('comes back empty where the scan does not reach', () => {
    expect(faceSlice(flatFace(), 50)).toEqual([]);
  });

  it('refuses an empty scan or a band of zero', () => {
    expect(() => faceSlice([], 70)).toThrow(ValidationError);
    expect(() => faceSlice(flatFace(), 70, 0)).toThrow(ValidationError);
  });
});

describe('burden at a level', () => {
  it('measures the horizontal distance to the face', () => {
    expect(burdenAtLevel(vertical, flatFace(3), 75)).toBe(3);
  });

  it('is unknown where the scan has no points', () => {
    expect(burdenAtLevel(vertical, flatFace(3), 50)).toBe(null);
  });

  it('shrinks as an angled hole leans toward the face', () => {
    const angled = { ...vertical, inclinationDeg: 15, bearingDeg: 270 };
    expect(burdenAtLevel(angled, flatFace(3), 74)).toBeLessThan(3);
  });
});

describe('the profile down a hole', () => {
  it('reads every metre from collar to bench toe', () => {
    const readings = burdenProfile(vertical, flatFace(), { stepM: 1 });
    expect(readings).toHaveLength(16);
    expect(readings[0].levelM).toBe(84);
    expect(readings.at(-1).levelM).toBe(69);
  });

  it('always finishes on the toe level even when the step does not land there', () => {
    const readings = burdenProfile(vertical, flatFace(), { stepM: 2 });
    expect(readings.at(-1).levelM).toBe(69);
  });

  it('refuses a step of zero', () => {
    expect(() => burdenProfile(vertical, flatFace(), { stepM: 0 })).toThrow(ValidationError);
  });

  it('finds the thinnest and thickest burden', () => {
    const face = [
      ...flatFace(3, 84, 76),
      { easting: collar.easting - 1.8, northing: 2000, level: 74 },
      { easting: collar.easting - 4.5, northing: 2000, level: 70 },
    ];
    const readings = burdenProfile(vertical, face, { stepM: 1, bandM: 0.4 });
    expect(minimumBurden(readings)).toEqual({ levelM: 74, burdenM: 1.8 });
    expect(maximumBurden(readings)).toEqual({ levelM: 70, burdenM: 4.5 });
  });

  it('reports nothing when the scan reached none of the hole', () => {
    const readings = burdenProfile(vertical, [{ easting: 0, northing: 0, level: 200 }], {
      stepM: 5,
    });
    expect(minimumBurden(readings)).toBe(null);
    expect(maximumBurden(readings)).toBe(null);
  });
});

describe('describeBurden', () => {
  it('rolls the readings up', () => {
    const described = describeBurden(vertical, flatFace(3.2), { stepM: 3 });
    expect(described.minimumBurdenM).toBe(3.2);
    expect(described.maximumBurdenM).toBe(3.2);
    expect(described.meanBurdenM).toBe(3.2);
    expect(described.coverage).toBe(1);
  });

  it('reports partial coverage rather than pretending', () => {
    const described = describeBurden(vertical, flatFace(3, 84, 78), { stepM: 1, bandM: 0.4 });
    expect(described.coverage).toBeLessThan(1);
    expect(described.coverage).toBeGreaterThan(0);
    expect(described.minimumBurdenM).toBe(3);
  });

  it('leaves every number unknown when nothing was scanned near the hole', () => {
    const described = describeBurden(vertical, [{ easting: 0, northing: 0, level: 300 }], {
      stepM: 5,
    });
    expect(described).toMatchObject({
      coverage: 0,
      minimumBurdenM: null,
      maximumBurdenM: null,
      meanBurdenM: null,
    });
  });
});

describe('faceAngle', () => {
  it('reads a vertical face as zero', () => {
    expect(faceAngle(flatFace())).toBe(0);
  });

  it('reads a battered face as leaning back', () => {
    const angled = [
      { easting: 997, northing: 2000, level: 84 },
      { easting: 1000, northing: 2000, level: 69 },
    ];
    expect(faceAngle(angled)).toBeCloseTo(11.31, 2);
  });

  it('reports an overhang as negative', () => {
    const overhung = [
      { easting: 997, northing: 2000, level: 84, overhang: true },
      { easting: 1000, northing: 2000, level: 69 },
    ];
    expect(faceAngle(overhung)).toBeLessThan(0);
  });

  it('has no answer for a scan with no height', () => {
    expect(faceAngle([{ easting: 1, northing: 1, level: 10 }])).toBe(null);
  });
});
