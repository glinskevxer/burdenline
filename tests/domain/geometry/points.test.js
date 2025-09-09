import { describe, it, expect } from 'vitest';
import {
  point,
  toRadians,
  toDegrees,
  normaliseBearing,
  planDistance,
  slopeDistance,
  bearingBetween,
  offsetBy,
  bearingDifference,
  closestPointOnSegment,
  distanceToPolyline,
  polygonArea,
  centroid,
  boundingBox,
} from '../../../src/domain/geometry/points.js';
import { ValidationError } from '../../../src/lib/errors.js';

describe('point', () => {
  it('defaults the level to datum and freezes what it makes', () => {
    const p = point(10, 20);
    expect(p).toEqual({ easting: 10, northing: 20, level: 0 });
    expect(Object.isFrozen(p)).toBe(true);
  });

  it('refuses a coordinate that is not a number and names it', () => {
    expect(() => point('10', 20)).toThrow(ValidationError);
    expect(() => point(10, Number.NaN)).toThrow(ValidationError);
  });
});

describe('angles', () => {
  it('converts both ways', () => {
    expect(toRadians(180)).toBeCloseTo(Math.PI, 12);
    expect(toDegrees(Math.PI / 2)).toBeCloseTo(90, 12);
  });

  it('wraps a bearing into a full circle', () => {
    expect(normaliseBearing(370)).toBe(10);
    expect(normaliseBearing(-90)).toBe(270);
    expect(normaliseBearing(360)).toBe(0);
  });
});

describe('distances', () => {
  it('measures plan distance on a three four five triangle', () => {
    expect(planDistance(point(0, 0), point(3, 4))).toBe(5);
  });

  it('ignores level in plan and includes it in slope', () => {
    const a = point(0, 0, 0);
    const b = point(3, 4, 12);
    expect(planDistance(a, b)).toBe(5);
    expect(slopeDistance(a, b)).toBe(13);
  });
});

describe('bearings', () => {
  it('measures clockwise from grid north', () => {
    const origin = point(0, 0);
    expect(bearingBetween(origin, point(0, 10))).toBe(0);
    expect(bearingBetween(origin, point(10, 0))).toBe(90);
    expect(bearingBetween(origin, point(0, -10))).toBe(180);
    expect(bearingBetween(origin, point(-10, 0))).toBe(270);
  });

  it('reads a point on top of the origin as north', () => {
    expect(bearingBetween(point(5, 5), point(5, 5))).toBe(0);
  });

  it('walks out and comes back to the same bearing', () => {
    const origin = point(1000, 2000);
    const moved = offsetBy(origin, 137, 25);
    expect(bearingBetween(origin, moved)).toBeCloseTo(137, 9);
    expect(planDistance(origin, moved)).toBeCloseTo(25, 9);
  });

  it('keeps the level when it steps sideways', () => {
    expect(offsetBy(point(0, 0, 84), 90, 3).level).toBe(84);
  });

  it('reports the signed difference the short way round', () => {
    expect(bearingDifference(10, 40)).toBe(30);
    expect(bearingDifference(40, 10)).toBe(-30);
    expect(bearingDifference(350, 10)).toBe(20);
    expect(bearingDifference(10, 350)).toBe(-20);
    expect(bearingDifference(0, 180)).toBe(180);
  });
});

describe('closest point on a segment', () => {
  const start = point(0, 0);
  const end = point(10, 0);

  it('drops a perpendicular when the foot is inside the segment', () => {
    const result = closestPointOnSegment(point(4, 3), start, end);
    expect(result.point.easting).toBeCloseTo(4, 9);
    expect(result.distance).toBeCloseTo(3, 9);
    expect(result.t).toBeCloseTo(0.4, 9);
  });

  it('clamps to the near end when the foot falls off it', () => {
    const before = closestPointOnSegment(point(-5, 0), start, end);
    expect(before.t).toBe(0);
    expect(before.distance).toBe(5);
    const after = closestPointOnSegment(point(15, 0), start, end);
    expect(after.t).toBe(1);
    expect(after.distance).toBe(5);
  });

  it('handles a segment of zero length', () => {
    const result = closestPointOnSegment(point(3, 4), start, start);
    expect(result.distance).toBe(5);
  });

  it('interpolates the level along the segment', () => {
    const result = closestPointOnSegment(point(5, 2), point(0, 0, 60), point(10, 0, 80));
    expect(result.point.level).toBeCloseTo(70, 9);
  });
});

describe('distance to a face profile', () => {
  const face = [point(0, 0), point(10, 0), point(20, 6)];

  it('picks the nearest segment', () => {
    const near = distanceToPolyline(point(5, 4), face);
    expect(near.segment).toBe(0);
    expect(near.distance).toBeCloseTo(4, 9);
  });

  it('finds the second segment when that is closer', () => {
    const near = distanceToPolyline(point(18, 8), face);
    expect(near.segment).toBe(1);
  });

  it('takes a profile of one shot', () => {
    expect(distanceToPolyline(point(3, 4), [point(0, 0)]).distance).toBe(5);
  });

  it('refuses an empty profile', () => {
    expect(() => distanceToPolyline(point(0, 0), [])).toThrow(TypeError);
  });
});

describe('areas and summaries', () => {
  it('measures a rectangle', () => {
    const ring = [point(0, 0), point(10, 0), point(10, 4), point(0, 4)];
    expect(polygonArea(ring)).toBe(40);
  });

  it('ignores the winding direction', () => {
    const ring = [point(0, 4), point(10, 4), point(10, 0), point(0, 0)];
    expect(polygonArea(ring)).toBe(40);
  });

  it('reads anything under three points as no area', () => {
    expect(polygonArea([point(0, 0), point(1, 1)])).toBe(0);
  });

  it('averages a cluster of collars', () => {
    const middle = centroid([point(0, 0, 10), point(4, 0, 20), point(2, 6, 30)]);
    expect(middle.easting).toBeCloseTo(2, 9);
    expect(middle.northing).toBeCloseTo(2, 9);
    expect(middle.level).toBeCloseTo(20, 9);
  });

  it('boxes a pattern', () => {
    const box = boundingBox([point(10, 5), point(2, 9), point(6, 1)]);
    expect(box).toEqual({ minEasting: 2, maxEasting: 10, minNorthing: 1, maxNorthing: 9 });
  });

  it('refuses to summarise nothing', () => {
    expect(() => centroid([])).toThrow(TypeError);
    expect(() => boundingBox([])).toThrow(TypeError);
  });
});
