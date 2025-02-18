import { describe, it, expect } from 'vitest';
import {
  parseHoleGeometry,
  drilledLength,
  verticalDrop,
  toeOffset,
  toePoint,
  describeHole,
  crossSectionArea,
  capacityPerMetre,
  loadingDensityKgPerM,
  collarSeparation,
  depthVariance,
  isChargeable,
  waterColumnM,
  HOLE_CONDITIONS,
  HOLE_STATUSES,
} from '../../../src/domain/geometry/hole.js';
import { ValidationError } from '../../../src/lib/errors.js';

const collar = { easting: 1000, northing: 2000, level: 84 };

const vertical = {
  collar,
  benchHeightM: 15,
  subdrillM: 1,
  inclinationDeg: 0,
  bearingDeg: 0,
  diameterMm: 102,
};

const inclined = { ...vertical, inclinationDeg: 15, bearingDeg: 90 };

describe('parsing', () => {
  it('fills in the defaults a simple vertical hole leaves out', () => {
    const parsed = parseHoleGeometry({ collar, benchHeightM: 12, diameterMm: 89 });
    expect(parsed.subdrillM).toBe(0);
    expect(parsed.inclinationDeg).toBe(0);
    expect(parsed.bearingDeg).toBe(0);
  });

  it('refuses an inclination past what a rig will drill', () => {
    expect(() => parseHoleGeometry({ ...vertical, inclinationDeg: 60 })).toThrow(ValidationError);
  });

  it('refuses a bearing of a full circle, which should be written as zero', () => {
    expect(() => parseHoleGeometry({ ...vertical, bearingDeg: 360 })).toThrow(ValidationError);
  });

  it('refuses a diameter no rig on a quarry carries', () => {
    expect(() => parseHoleGeometry({ ...vertical, diameterMm: 12 })).toThrow(ValidationError);
  });
});

describe('length', () => {
  it('is the bench height plus subdrill when the hole is vertical', () => {
    expect(drilledLength(vertical)).toBeCloseTo(16, 9);
  });

  it('grows with the angle', () => {
    expect(drilledLength(inclined)).toBeCloseTo(15 / Math.cos((15 * Math.PI) / 180) + 1, 9);
    expect(drilledLength(inclined)).toBeGreaterThan(drilledLength(vertical));
  });

  it('drops less than it is long once inclined', () => {
    expect(verticalDrop(inclined)).toBeLessThan(drilledLength(inclined));
    expect(verticalDrop(vertical)).toBeCloseTo(16, 9);
  });
});

describe('the toe', () => {
  it('sits directly below the collar for a vertical hole', () => {
    expect(toeOffset(vertical)).toBeCloseTo(0, 12);
    const toe = toePoint(vertical);
    expect(toe.easting).toBeCloseTo(collar.easting, 9);
    expect(toe.level).toBeCloseTo(68, 9);
  });

  it('steps out along the bearing once the hole is angled', () => {
    const toe = toePoint(inclined);
    expect(toe.easting).toBeGreaterThan(collar.easting);
    expect(toe.northing).toBeCloseTo(collar.northing, 9);
    expect(toe.easting - collar.easting).toBeCloseTo(toeOffset(inclined), 9);
  });

  it('puts the toe below the bench toe by the subdrill', () => {
    const toe = toePoint(inclined);
    expect(collar.level - toe.level).toBeCloseTo(verticalDrop(inclined), 9);
    expect(collar.level - toe.level).toBeGreaterThan(15);
  });
});

describe('describeHole', () => {
  it('rounds the numbers a plan sheet prints', () => {
    const described = describeHole(inclined);
    expect(described.lengthM).toBeCloseTo(16.529, 3);
    expect(described.bearingDeg).toBe(90);
    expect(described.diameterMm).toBe(102);
  });

  it('carries the collar through untouched', () => {
    expect(describeHole(vertical).collar).toEqual(collar);
  });

  it('reports how many litres a metre holds', () => {
    expect(describeHole(vertical).litresPerMetre).toBeCloseTo(8.171, 3);
  });
});

describe('hole capacity', () => {
  it('measures the cross section from the diameter', () => {
    expect(crossSectionArea(100)).toBeCloseTo(0.00785398, 8);
  });

  it('reads a 102 millimetre hole as a little over eight litres a metre', () => {
    expect(capacityPerMetre(102)).toBeCloseTo(8.1713, 3);
  });

  it('turns a product density into kilograms a metre', () => {
    expect(loadingDensityKgPerM(102, 1150)).toBeCloseTo(9.397, 3);
  });

  it('refuses a density of zero', () => {
    expect(() => loadingDensityKgPerM(102, 0)).toThrow(ValidationError);
  });
});

describe('the small reads the rest of the system makes', () => {
  it('measures collar separation from either shape', () => {
    expect(
      collarSeparation({ collar: { easting: 0, northing: 0 } }, { easting: 3, northing: 4 }),
    ).toBe(5);
  });

  it('reports drill variance and leaves it unknown until the rig reports', () => {
    expect(depthVariance({ designedDepthM: 16, drilledDepthM: 16.4 })).toBe(0.4);
    expect(depthVariance({ designedDepthM: 16, drilledDepthM: 15.5 })).toBe(-0.5);
    expect(depthVariance({ designedDepthM: 16, drilledDepthM: null })).toBe(null);
    expect(depthVariance({ designedDepthM: 16 })).toBe(null);
  });

  it('will not charge a hole that has collapsed or is not drilled yet', () => {
    expect(isChargeable({ status: 'drilled', condition: 'wet' })).toBe(true);
    expect(isChargeable({ status: 'drilled', condition: 'collapsed' })).toBe(false);
    expect(isChargeable({ status: 'planned', condition: 'dry' })).toBe(false);
    expect(isChargeable(null)).toBe(false);
  });

  it('caps the water column at the depth of the hole', () => {
    expect(waterColumnM({ waterDepthM: 4, drilledDepthM: 16 })).toBe(4);
    expect(waterColumnM({ waterDepthM: 20, drilledDepthM: 16 })).toBe(16);
    expect(waterColumnM({ waterDepthM: 0, drilledDepthM: 16 })).toBe(0);
    expect(waterColumnM({})).toBe(0);
  });
});

describe('the vocabularies', () => {
  it('matches what the schema allows', () => {
    expect(HOLE_CONDITIONS).toContain('cavity');
    expect(HOLE_STATUSES).toContain('redrill');
    expect(new Set(HOLE_CONDITIONS).size).toBe(HOLE_CONDITIONS.length);
  });
});
