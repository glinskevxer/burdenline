/**
 * Fitting a pattern into the shape the bench actually is.
 *
 * A rectangle of holes is what a design sheet shows and almost never what gets
 * drilled. The bench has a boundary: the crest on one side, the highwall on
 * another, an access ramp cutting the corner off. Holes outside it are holes
 * nobody can drill, and holes too close to the crest are the ones that throw.
 *
 * So the layout is generated as a full grid and then filtered against the
 * boundary, with a standoff from the edge that the site sets. The count that
 * comes out is smaller than rows times holes per row, and every design number
 * downstream has to use the count that comes out rather than the one that went
 * in. That mismatch was the bug this module exists to make impossible.
 */

import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';
import { requirePositive } from '../../lib/guards.js';
import { point, planDistance, distanceToPolyline, polygonArea, boundingBox } from './points.js';

export const DEFAULT_FIT_RULES = Object.freeze({
  crestStandoffM: 2,
  boundaryStandoffM: 1.5,
  minimumHoles: 4,
});

/** Ray casting: is a point inside a closed ring? */
export function insidePolygon(target, ring) {
  if (!Array.isArray(ring) || ring.length < 3) {
    throw new ValidationError('a boundary needs at least three points', [
      { path: 'boundary', message: 'not a polygon', kind: 'malformed' },
    ]);
  }
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    const straddles = a.northing > target.northing !== b.northing > target.northing;
    if (!straddles) {
      continue;
    }
    const crossing =
      a.easting +
      ((target.northing - a.northing) * (b.easting - a.easting)) / (b.northing - a.northing);
    if (target.easting < crossing) {
      inside = !inside;
    }
  }
  return inside;
}

/** How far a point is from the boundary, whichever edge is nearest. */
export function distanceToBoundary(target, ring) {
  const closed = [...ring, ring[0]];
  return roundTo(distanceToPolyline(target, closed).distance, 3);
}

/**
 * Filter a laid out pattern down to the holes that can actually be drilled, and
 * say why each of the others was dropped.
 */
export function fitToBench({ holes, boundary, crest = null, rules = DEFAULT_FIT_RULES }) {
  if (!Array.isArray(holes) || holes.length === 0) {
    throw new ValidationError('there are no holes to fit', [
      { path: 'holes', message: 'lay the pattern out first', kind: 'missing' },
    ]);
  }
  requirePositive(rules.boundaryStandoffM, 'boundaryStandoffM');
  const kept = [];
  const dropped = [];
  for (const hole of holes) {
    const at = point(hole.easting, hole.northing, hole.collarLevelM ?? 0);
    if (!insidePolygon(at, boundary)) {
      dropped.push({ holeNumber: hole.holeNumber, reason: 'outside_the_bench' });
      continue;
    }
    const fromEdge = distanceToBoundary(at, boundary);
    if (fromEdge < rules.boundaryStandoffM) {
      dropped.push({
        holeNumber: hole.holeNumber,
        reason: 'too_close_to_the_boundary',
        distanceM: fromEdge,
      });
      continue;
    }
    if (crest) {
      const fromCrest = roundTo(distanceToPolyline(at, crest).distance, 3);
      if (fromCrest < rules.crestStandoffM) {
        dropped.push({
          holeNumber: hole.holeNumber,
          reason: 'too_close_to_the_crest',
          distanceM: fromCrest,
        });
        continue;
      }
    }
    kept.push({ ...hole, distanceToBoundaryM: fromEdge });
  }

  return {
    holes: renumber(kept),
    dropped,
    keptCount: kept.length,
    droppedCount: dropped.length,
    usable: kept.length >= rules.minimumHoles,
    coverage: roundTo(kept.length / holes.length, 3),
    boundaryAreaM2: roundTo(polygonArea(boundary), 2),
  };
}

/**
 * Numbering runs from one over the holes that survived. Keeping the original
 * numbers leaves gaps, and a crew calling out hole seventeen when there are
 * fourteen holes on the bench is exactly the confusion to avoid.
 */
export function renumber(holes) {
  return holes.map((hole, index) => ({
    ...hole,
    originalHoleNumber: hole.holeNumber,
    holeNumber: index + 1,
  }));
}

/** Whether the pattern origin is anywhere near the bench at all. */
export function checkOrigin(origin, boundary) {
  const box = boundingBox(boundary);
  const inside = insidePolygon(origin, boundary);
  const nearest = distanceToBoundary(origin, boundary);
  return {
    inside,
    distanceToBoundaryM: nearest,
    boundingBox: box,
    plausible: inside || nearest < 50,
  };
}

/** The rock the fitted pattern is responsible for, which is not the rectangle. */
export function fittedVolume({ holes, burdenM, spacingM, benchHeightM }) {
  requirePositive(burdenM, 'burdenM');
  requirePositive(spacingM, 'spacingM');
  requirePositive(benchHeightM, 'benchHeightM');
  return roundTo(holes.length * burdenM * spacingM * benchHeightM, 3);
}

/** The gap left between two holes once one of them has been dropped. */
export function largestGap(holes) {
  if (holes.length < 2) {
    return null;
  }
  let widest = { distanceM: 0, between: null };
  for (let i = 0; i < holes.length; i += 1) {
    let nearest = Infinity;
    let neighbour = null;
    for (let j = 0; j < holes.length; j += 1) {
      if (i === j) {
        continue;
      }
      const distance = planDistance(holes[i], holes[j]);
      if (distance < nearest) {
        nearest = distance;
        neighbour = holes[j].holeNumber;
      }
    }
    if (nearest > widest.distanceM) {
      widest = { distanceM: roundTo(nearest, 3), between: [holes[i].holeNumber, neighbour] };
    }
  }
  return widest;
}
