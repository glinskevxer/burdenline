/**
 * Site grid geometry.
 *
 * Everything is metres on the local grid: easting to the right, northing up,
 * level positive above datum. Bearings are in degrees clockwise from grid north,
 * which is how the drill plan is handed to the rig and how the surveyor reads a
 * face profile back. Trigonometry lives here so that nothing else has to
 * remember that a bearing is measured from the northing axis and not the
 * easting one.
 */

const TWO_PI = Math.PI * 2;

export function point(easting, northing, level = 0) {
  assertNumber(easting, 'easting');
  assertNumber(northing, 'northing');
  assertNumber(level, 'level');
  return Object.freeze({ easting, northing, level });
}

export function toRadians(degrees) {
  assertNumber(degrees, 'degrees');
  return (degrees * Math.PI) / 180;
}

export function toDegrees(radians) {
  assertNumber(radians, 'radians');
  return (radians * 180) / Math.PI;
}

export function normaliseBearing(degrees) {
  assertNumber(degrees, 'degrees');
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Plan distance, ignoring level. This is what a burden is measured on. */
export function planDistance(a, b) {
  const de = b.easting - a.easting;
  const dn = b.northing - a.northing;
  return Math.hypot(de, dn);
}

export function slopeDistance(a, b) {
  const dl = (b.level ?? 0) - (a.level ?? 0);
  return Math.hypot(planDistance(a, b), dl);
}

export function bearingBetween(from, to) {
  const de = to.easting - from.easting;
  const dn = to.northing - from.northing;
  if (de === 0 && dn === 0) {
    return 0;
  }
  return normaliseBearing(toDegrees(Math.atan2(de, dn)));
}

/** Step a given distance along a bearing, staying at the same level. */
export function offsetBy(origin, bearingDegrees, distance) {
  assertNumber(distance, 'distance');
  const radians = toRadians(normaliseBearing(bearingDegrees));
  return point(
    origin.easting + Math.sin(radians) * distance,
    origin.northing + Math.cos(radians) * distance,
    origin.level ?? 0,
  );
}

/** The signed smaller angle between two bearings, positive clockwise. */
export function bearingDifference(a, b) {
  const difference = normaliseBearing(b) - normaliseBearing(a);
  if (difference > 180) {
    return difference - 360;
  }
  if (difference <= -180) {
    return difference + 360;
  }
  return difference;
}

/**
 * The closest point on a segment to a target, and how far away it is. The face
 * profile is a polyline of survey shots and the real burden of a hole is its
 * distance to that polyline, so this is the workhorse of the burden check.
 */
export function closestPointOnSegment(target, start, end) {
  const de = end.easting - start.easting;
  const dn = end.northing - start.northing;
  const lengthSquared = de * de + dn * dn;
  if (lengthSquared === 0) {
    return { point: start, distance: planDistance(target, start), t: 0 };
  }
  const raw =
    ((target.easting - start.easting) * de + (target.northing - start.northing) * dn) /
    lengthSquared;
  const t = Math.min(Math.max(raw, 0), 1);
  const nearest = point(
    start.easting + de * t,
    start.northing + dn * t,
    (start.level ?? 0) + ((end.level ?? 0) - (start.level ?? 0)) * t,
  );
  return { point: nearest, distance: planDistance(target, nearest), t };
}

export function distanceToPolyline(target, polyline) {
  if (!Array.isArray(polyline) || polyline.length === 0) {
    throw new TypeError('a polyline needs at least one point');
  }
  if (polyline.length === 1) {
    return { distance: planDistance(target, polyline[0]), point: polyline[0], segment: 0 };
  }
  let best = null;
  for (let index = 0; index < polyline.length - 1; index += 1) {
    const candidate = closestPointOnSegment(target, polyline[index], polyline[index + 1]);
    if (!best || candidate.distance < best.distance) {
      best = { distance: candidate.distance, point: candidate.point, segment: index };
    }
  }
  return best;
}

/** Shoelace area of a closed ring in square metres, sign ignored. */
export function polygonArea(ring) {
  if (!Array.isArray(ring) || ring.length < 3) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    sum += current.easting * next.northing - next.easting * current.northing;
  }
  return Math.abs(sum) / 2;
}

export function centroid(points) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new TypeError('a centroid needs at least one point');
  }
  const sum = points.reduce(
    (accumulator, item) => ({
      easting: accumulator.easting + item.easting,
      northing: accumulator.northing + item.northing,
      level: accumulator.level + (item.level ?? 0),
    }),
    { easting: 0, northing: 0, level: 0 },
  );
  return point(
    sum.easting / points.length,
    sum.northing / points.length,
    sum.level / points.length,
  );
}

export function boundingBox(points) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new TypeError('a bounding box needs at least one point');
  }
  return points.reduce(
    (box, item) => ({
      minEasting: Math.min(box.minEasting, item.easting),
      maxEasting: Math.max(box.maxEasting, item.easting),
      minNorthing: Math.min(box.minNorthing, item.northing),
      maxNorthing: Math.max(box.maxNorthing, item.northing),
    }),
    {
      minEasting: Infinity,
      maxEasting: -Infinity,
      minNorthing: Infinity,
      maxNorthing: -Infinity,
    },
  );
}

function assertNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

export const constants = { TWO_PI };
