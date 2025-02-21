import { describe, it, expect } from 'vitest';
import {
  layoutPattern,
  volumePerHole,
  patternVolume,
  patternTonnes,
  spacingToBurdenRatio,
  stiffnessRatio,
  summarisePattern,
  LAYOUTS,
} from '../../../src/domain/geometry/pattern.js';
import { planDistance } from '../../../src/domain/geometry/points.js';
import { ValidationError } from '../../../src/lib/errors.js';

const design = {
  origin: { easting: 1000, northing: 2000, level: 84 },
  faceBearingDeg: 0,
  layout: 'staggered',
  rowCount: 3,
  holesPerRow: 5,
  burdenM: 3,
  spacingM: 3.5,
  benchHeightM: 15,
  subdrillM: 1,
  inclinationDeg: 0,
  diameterMm: 102,
};

describe('layoutPattern', () => {
  it('lays out every hole', () => {
    const { holes } = layoutPattern(design);
    expect(holes).toHaveLength(15);
    expect(holes.at(-1).holeNumber).toBe(15);
  });

  it('numbers the holes in the order the rig drills them', () => {
    const { holes } = layoutPattern({ ...design, layout: 'square', rowCount: 2, holesPerRow: 3 });
    expect(holes.map((hole) => hole.holeNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(holes.map((hole) => hole.rowNumber)).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it('runs the second row back the other way', () => {
    const { holes } = layoutPattern({ ...design, layout: 'square', rowCount: 2, holesPerRow: 3 });
    const firstRow = holes.filter((hole) => hole.rowNumber === 1);
    const secondRow = holes.filter((hole) => hole.rowNumber === 2);
    expect(firstRow[0].northing).toBeLessThan(firstRow[2].northing);
    expect(secondRow[0].northing).toBeGreaterThan(secondRow[2].northing);
  });

  it('spaces holes along the face by the spacing', () => {
    const { holes } = layoutPattern({ ...design, layout: 'square' });
    const first = holes[0];
    const second = holes[1];
    expect(
      planDistance(
        { easting: first.easting, northing: first.northing },
        { easting: second.easting, northing: second.northing },
      ),
    ).toBeCloseTo(3.5, 6);
  });

  it('steps rows back into the rock by the burden', () => {
    const { holes } = layoutPattern({ ...design, layout: 'square' });
    const rowOne = holes.find((hole) => hole.rowNumber === 1);
    const rowTwo = holes.find((hole) => hole.rowNumber === 2);
    expect(rowTwo.easting - rowOne.easting).toBeCloseTo(3, 6);
  });

  it('shifts the even rows by half a spacing when staggered', () => {
    const { holes } = layoutPattern(design);
    const rowOne = holes.filter((hole) => hole.rowNumber === 1);
    const rowTwo = holes
      .filter((hole) => hole.rowNumber === 2)
      .slice()
      .reverse();
    expect(rowTwo[0].northing - rowOne[0].northing).toBeCloseTo(1.75, 6);
  });

  it('leaves a square pattern lined up', () => {
    const { holes } = layoutPattern({ ...design, layout: 'square' });
    const rowOne = holes.filter((hole) => hole.rowNumber === 1);
    const rowTwo = holes
      .filter((hole) => hole.rowNumber === 2)
      .slice()
      .reverse();
    expect(rowTwo[0].northing).toBeCloseTo(rowOne[0].northing, 6);
  });

  it('gives every hole the designed length', () => {
    const { holes } = layoutPattern(design);
    for (const hole of holes) {
      expect(hole.designedDepthM).toBe(16);
    }
  });

  it('points an angled hole back into the rock', () => {
    const { holes, intoRockBearingDeg } = layoutPattern({ ...design, inclinationDeg: 15 });
    expect(intoRockBearingDeg).toBe(90);
    expect(holes[0].bearingDeg).toBe(270);
    expect(holes[0].designedDepthM).toBeGreaterThan(16);
  });

  it('leaves a vertical hole without a bearing', () => {
    expect(layoutPattern(design).holes[0].bearingDeg).toBe(0);
  });

  it('follows a face that does not run north', () => {
    const { alongFaceBearingDeg, intoRockBearingDeg } = layoutPattern({
      ...design,
      faceBearingDeg: 300,
    });
    expect(alongFaceBearingDeg).toBe(300);
    expect(intoRockBearingDeg).toBe(30);
  });

  it('refuses a single row pattern with more than one row', () => {
    expect(() => layoutPattern({ ...design, layout: 'single_row' })).toThrow(ValidationError);
    expect(() => layoutPattern({ ...design, layout: 'single_row', rowCount: 1 })).not.toThrow();
  });

  it('refuses a pattern nobody could drill', () => {
    expect(() => layoutPattern({ ...design, rowCount: 0 })).toThrow(ValidationError);
    expect(() => layoutPattern({ ...design, burdenM: 0 })).toThrow(ValidationError);
    expect(() => layoutPattern({ ...design, holesPerRow: 500 })).toThrow(ValidationError);
  });
});

describe('volumes', () => {
  it('measures the rock one hole answers for', () => {
    expect(volumePerHole(design)).toBe(157.5);
  });

  it('multiplies out across the pattern', () => {
    expect(patternVolume({ ...design, holeCount: 15 })).toBe(2362.5);
  });

  it('refuses a pattern with no holes', () => {
    expect(() => patternVolume({ ...design, holeCount: 0 })).toThrow(ValidationError);
  });

  it('turns volume into tonnes at the rock density', () => {
    expect(patternTonnes({ volumeM3: 2362.5, rockDensityKgM3: 2700 })).toBe(6378.75);
  });

  it('refuses a negative dimension', () => {
    expect(() => volumePerHole({ ...design, burdenM: -3 })).toThrow(ValidationError);
    expect(() => patternTonnes({ volumeM3: 100, rockDensityKgM3: 0 })).toThrow(ValidationError);
  });
});

describe('the shape ratios a designer reads', () => {
  it('reports spacing over burden', () => {
    expect(spacingToBurdenRatio({ burdenM: 3, spacingM: 3.5 })).toBe(1.167);
  });

  it('reports the stiffness of the bench', () => {
    expect(stiffnessRatio({ benchHeightM: 15, burdenM: 3 })).toBe(5);
    expect(stiffnessRatio({ benchHeightM: 5, burdenM: 3 })).toBe(1.667);
  });
});

describe('summarisePattern', () => {
  it('rolls the design up for the plan sheet', () => {
    const { holes } = layoutPattern(design);
    const summary = summarisePattern(design, holes);
    expect(summary).toMatchObject({
      holeCount: 15,
      rowCount: 3,
      totalDrillingM: 240,
      volumeM3: 2362.5,
      volumePerHoleM3: 157.5,
      spacingToBurden: 1.167,
      stiffness: 5,
    });
  });
});

describe('the layout vocabulary', () => {
  it('lists what the schema accepts', () => {
    expect(LAYOUTS).toEqual(['square', 'staggered', 'single_row']);
  });
});
