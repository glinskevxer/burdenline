/**
 * A single blast hole.
 *
 * The collar is where the rig stands. The toe is where the hole ends, below and
 * usually in front of the collar because production holes are drilled at an
 * angle to hold the face back. Everything downstream needs the along hole length
 * rather than the vertical drop, so that is computed once here and never
 * rederived by eye.
 */

import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';
import { point, offsetBy, toRadians, normaliseBearing, planDistance } from './points.js';

export const HOLE_CONDITIONS = ['dry', 'damp', 'wet', 'cavity', 'collapsed', 'lost'];
export const HOLE_STATUSES = ['planned', 'drilled', 'redrill', 'charged', 'fired', 'abandoned'];

export const holeGeometrySchema = z.object({
  collar: z.object({
    easting: z.number().finite(),
    northing: z.number().finite(),
    level: z.number().finite(),
  }),
  benchHeightM: z.number().positive().max(60),
  subdrillM: z.number().min(0).max(6).default(0),
  inclinationDeg: z.number().min(0).max(45).default(0),
  bearingDeg: z.number().min(0).lt(360).default(0),
  diameterMm: z.number().min(25).max(400),
});

export function parseHoleGeometry(input) {
  const parsed = holeGeometrySchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the hole geometry is not usable');
  }
  return parsed.data;
}

/**
 * Along hole length from the collar to the toe. A hole drilled at an angle has
 * to be longer than the bench is high to reach the same level, and the subdrill
 * is measured along the hole, not vertically.
 */
export function drilledLength({ benchHeightM, subdrillM = 0, inclinationDeg = 0 }) {
  const radians = toRadians(inclinationDeg);
  return benchHeightM / Math.cos(radians) + subdrillM;
}

export function verticalDrop({ benchHeightM, subdrillM = 0, inclinationDeg = 0 }) {
  return benchHeightM + subdrillM * Math.cos(toRadians(inclinationDeg));
}

/** How far in front of its collar the toe of a hole sits, in plan. */
export function toeOffset({ benchHeightM, subdrillM = 0, inclinationDeg = 0 }) {
  const radians = toRadians(inclinationDeg);
  return (benchHeightM / Math.cos(radians) + subdrillM) * Math.sin(radians);
}

export function toePoint(geometry) {
  const { collar, bearingDeg = 0 } = geometry;
  const offset = toeOffset(geometry);
  const moved = offsetBy(point(collar.easting, collar.northing, collar.level), bearingDeg, offset);
  return point(moved.easting, moved.northing, collar.level - verticalDrop(geometry));
}

/** The full geometric picture of a hole, computed once from the design inputs. */
export function describeHole(input) {
  const geometry = parseHoleGeometry(input);
  const length = drilledLength(geometry);
  const toe = toePoint(geometry);
  return {
    collar: point(geometry.collar.easting, geometry.collar.northing, geometry.collar.level),
    toe,
    lengthM: roundTo(length, 3),
    verticalDropM: roundTo(verticalDrop(geometry), 3),
    toeOffsetM: roundTo(toeOffset(geometry), 3),
    toeLevelM: roundTo(toe.level, 3),
    inclinationDeg: geometry.inclinationDeg,
    bearingDeg: normaliseBearing(geometry.bearingDeg),
    diameterMm: geometry.diameterMm,
    crossSectionM2: crossSectionArea(geometry.diameterMm),
    litresPerMetre: roundTo(crossSectionArea(geometry.diameterMm) * 1000, 4),
  };
}

/** Cross section of the hole in square metres, from a diameter in millimetres. */
export function crossSectionArea(diameterMm) {
  const radius = diameterMm / 2000;
  return Math.PI * radius * radius;
}

/** Litres a metre of hole holds, which is how loading rates are quoted. */
export function capacityPerMetre(diameterMm) {
  return roundTo(crossSectionArea(diameterMm) * 1000, 4);
}

/**
 * The mass of an explosive that fills one metre of the hole. The loading density
 * of a pumped product varies with the hole, so it is an argument, not a constant.
 */
export function loadingDensityKgPerM(diameterMm, densityKgPerM3) {
  if (!(densityKgPerM3 > 0)) {
    throw new ValidationError('a product density has to be positive', [
      { path: 'densityKgPerM3', message: 'must be greater than zero', kind: 'range' },
    ]);
  }
  return roundTo(crossSectionArea(diameterMm) * densityKgPerM3, 4);
}

/** How far apart two collars are, which the pattern check reads hole by hole. */
export function collarSeparation(a, b) {
  return roundTo(planDistance(a.collar ?? a, b.collar ?? b), 3);
}

/** Overdrill or short drill against the design, positive when the rig went deeper. */
export function depthVariance({ designedDepthM, drilledDepthM }) {
  if (drilledDepthM === null || drilledDepthM === undefined) {
    return null;
  }
  return roundTo(drilledDepthM - designedDepthM, 3);
}

export function isChargeable(hole) {
  if (!hole) {
    return false;
  }
  if (hole.condition === 'collapsed' || hole.condition === 'lost') {
    return false;
  }
  return hole.status === 'drilled' || hole.status === 'charged';
}

/** Water in the hole decides which products may go into it. */
export function waterColumnM(hole) {
  if (!hole?.waterDepthM) {
    return 0;
  }
  const depth = hole.drilledDepthM ?? hole.designedDepthM ?? 0;
  return roundTo(Math.min(hole.waterDepthM, depth), 3);
}
