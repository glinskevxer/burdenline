import { describe, it, expect } from 'vitest';
import {
  insidePolygon,
  distanceToBoundary,
  fitToBench,
  renumber,
  checkOrigin,
  fittedVolume,
  largestGap,
  DEFAULT_FIT_RULES,
} from '../../../src/domain/geometry/pattern-fit.js';
import { layoutPattern } from '../../../src/domain/geometry/pattern.js';
import { ValidationError } from '../../../src/lib/errors.js';

/** A twenty by twenty metre bench with its corner cut off by a ramp. */
const boundary = [
  { easting: 0, northing: 0 },
  { easting: 20, northing: 0 },
  { easting: 20, northing: 14 },
  { easting: 14, northing: 20 },
  { easting: 0, northing: 20 },
];

const design = {
  origin: { easting: 3, northing: 3, level: 84 },
  faceBearingDeg: 0,
  layout: 'square',
  rowCount: 6,
  holesPerRow: 6,
  burdenM: 3.5,
  spacingM: 3.5,
  benchHeightM: 15,
  subdrillM: 1,
  diameterMm: 102,
};

describe('insidePolygon', () => {
  it('takes a point in the middle', () => {
    expect(insidePolygon({ easting: 10, northing: 10 }, boundary)).toBe(true);
  });

  it('leaves a point outside out', () => {
    expect(insidePolygon({ easting: 25, northing: 10 }, boundary)).toBe(false);
    expect(insidePolygon({ easting: -1, northing: 10 }, boundary)).toBe(false);
  });

  it('respects the cut corner', () => {
    expect(insidePolygon({ easting: 19, northing: 19 }, boundary)).toBe(false);
    expect(insidePolygon({ easting: 15, northing: 15 }, boundary)).toBe(true);
  });

  it('refuses something that is not a polygon', () => {
    expect(() => insidePolygon({ easting: 0, northing: 0 }, [{ easting: 0, northing: 0 }])).toThrow(
      ValidationError,
    );
  });
});

describe('distanceToBoundary', () => {
  it('measures to the nearest edge', () => {
    expect(distanceToBoundary({ easting: 2, northing: 10 }, boundary)).toBe(2);
    expect(distanceToBoundary({ easting: 10, northing: 1 }, boundary)).toBe(1);
  });

  it('measures from outside as well', () => {
    expect(distanceToBoundary({ easting: 24, northing: 10 }, boundary)).toBe(4);
  });
});

describe('fitToBench', () => {
  const { holes } = layoutPattern(design);

  it('keeps the holes that fall inside and drops the rest', () => {
    const fitted = fitToBench({ holes, boundary });
    expect(fitted.keptCount + fitted.droppedCount).toBe(holes.length);
    expect(fitted.droppedCount).toBeGreaterThan(0);
    expect(fitted.usable).toBe(true);
  });

  it('says why each hole was dropped', () => {
    const fitted = fitToBench({ holes, boundary });
    const reasons = new Set(fitted.dropped.map((entry) => entry.reason));
    expect([...reasons].every((reason) => reason.length > 0)).toBe(true);
  });

  it('drops a hole standing too close to the edge', () => {
    const close = [{ holeNumber: 99, rowNumber: 1, easting: 0.5, northing: 10, collarLevelM: 84 }];
    const fitted = fitToBench({ holes: close, boundary });
    expect(fitted.dropped[0].reason).toBe('too_close_to_the_boundary');
    expect(fitted.usable).toBe(false);
  });

  it('drops a hole too close to the crest when one is given', () => {
    const crest = [
      { easting: 0, northing: 12 },
      { easting: 20, northing: 12 },
    ];
    const close = [{ holeNumber: 1, rowNumber: 1, easting: 10, northing: 13, collarLevelM: 84 }];
    const fitted = fitToBench({ holes: close, boundary, crest });
    expect(fitted.dropped[0].reason).toBe('too_close_to_the_crest');
  });

  it('follows a wider standoff', () => {
    const loose = fitToBench({ holes, boundary });
    const tight = fitToBench({
      holes,
      boundary,
      rules: { ...DEFAULT_FIT_RULES, boundaryStandoffM: 5 },
    });
    expect(tight.keptCount).toBeLessThan(loose.keptCount);
  });

  it('renumbers what is left from one', () => {
    const fitted = fitToBench({ holes, boundary });
    expect(fitted.holes.map((hole) => hole.holeNumber)).toEqual(
      fitted.holes.map((_hole, index) => index + 1),
    );
    expect(fitted.holes[0].originalHoleNumber).toBeGreaterThan(0);
  });

  it('reports how much of the pattern survived', () => {
    const fitted = fitToBench({ holes, boundary });
    expect(fitted.coverage).toBeGreaterThan(0);
    expect(fitted.coverage).toBeLessThanOrEqual(1);
    expect(fitted.boundaryAreaM2).toBeGreaterThan(300);
  });

  it('refuses an empty pattern', () => {
    expect(() => fitToBench({ holes: [], boundary })).toThrow(ValidationError);
  });
});

describe('renumber', () => {
  it('keeps the original number so the plan can be read back', () => {
    const renumbered = renumber([{ holeNumber: 4 }, { holeNumber: 9 }]);
    expect(renumbered.map((hole) => hole.holeNumber)).toEqual([1, 2]);
    expect(renumbered.map((hole) => hole.originalHoleNumber)).toEqual([4, 9]);
  });
});

describe('checkOrigin', () => {
  it('says an origin on the bench is fine', () => {
    const check = checkOrigin({ easting: 5, northing: 5 }, boundary);
    expect(check.inside).toBe(true);
    expect(check.plausible).toBe(true);
  });

  it('says an origin a little outside is still plausible', () => {
    expect(checkOrigin({ easting: 25, northing: 10 }, boundary).plausible).toBe(true);
  });

  it('says an origin in the next county is not', () => {
    const check = checkOrigin({ easting: 5000, northing: 5000 }, boundary);
    expect(check.plausible).toBe(false);
    expect(check.distanceToBoundaryM).toBeGreaterThan(1000);
  });
});

describe('the numbers that come out of a fit', () => {
  it('works the volume out from the holes that survived', () => {
    const { holes } = layoutPattern(design);
    const fitted = fitToBench({ holes, boundary });
    const volume = fittedVolume({
      holes: fitted.holes,
      burdenM: 3.5,
      spacingM: 3.5,
      benchHeightM: 15,
    });
    expect(volume).toBe(fitted.keptCount * 3.5 * 3.5 * 15);
    expect(volume).toBeLessThan(
      fittedVolume({ holes, burdenM: 3.5, spacingM: 3.5, benchHeightM: 15 }),
    );
  });

  it('finds the widest gap a dropped hole left', () => {
    const holes = [
      { holeNumber: 1, easting: 0, northing: 0 },
      { holeNumber: 2, easting: 3.5, northing: 0 },
      { holeNumber: 3, easting: 14, northing: 0 },
    ];
    const gap = largestGap(holes);
    expect(gap.distanceM).toBe(10.5);
    expect(gap.between).toEqual([3, 2]);
  });

  it('has no gap to report in a pattern of one', () => {
    expect(largestGap([{ holeNumber: 1, easting: 0, northing: 0 }])).toBe(null);
  });
});
