/**
 * Laying a pattern out on the bench.
 *
 * The first row sits a burden back from the face and runs along it. Every row
 * behind it is another burden back. A staggered pattern shifts the odd rows by
 * half a spacing, which is what gets a decent break out of a wide spacing to
 * burden ratio. Hole numbering runs along each row and then back along the next,
 * because that is the order a rig actually drills them and the order the crew
 * calls them out when they tie the shot in.
 */

import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import { requirePositive, requireWholeNumber } from '../../lib/guards.js';
import { roundTo } from '../../lib/units.js';
import { point, offsetBy, normaliseBearing } from './points.js';
import { drilledLength } from './hole.js';

export const LAYOUTS = ['square', 'staggered', 'single_row'];

export const patternLayoutSchema = z.object({
  origin: z.object({
    easting: z.number().finite(),
    northing: z.number().finite(),
    level: z.number().finite(),
  }),
  faceBearingDeg: z.number().min(0).lt(360),
  layout: z.enum(['square', 'staggered', 'single_row']).default('staggered'),
  rowCount: z.number().int().min(1).max(20),
  holesPerRow: z.number().int().min(1).max(200),
  burdenM: z.number().positive().max(20),
  spacingM: z.number().positive().max(20),
  benchHeightM: z.number().positive().max(60),
  subdrillM: z.number().min(0).max(6).default(0),
  inclinationDeg: z.number().min(0).max(45).default(0),
  diameterMm: z.number().min(25).max(400),
});

/**
 * Holes run along the face bearing. Rows step back on the bearing plus ninety
 * degrees, which is into the rock, since the face bearing is written down with
 * the rock on the right.
 */
export function layoutPattern(input) {
  const parsed = patternLayoutSchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the pattern layout is not usable');
  }
  const design = parsed.data;
  if (design.layout === 'single_row' && design.rowCount !== 1) {
    throw new ValidationError('a single row pattern has one row', [
      { path: 'rowCount', message: 'must be 1 for a single row pattern', kind: 'inconsistent' },
    ]);
  }

  const alongFace = normaliseBearing(design.faceBearingDeg);
  const intoRock = normaliseBearing(alongFace + 90);
  const holeBearing = normaliseBearing(intoRock + 180);
  const origin = point(design.origin.easting, design.origin.northing, design.origin.level);

  const holes = [];
  let number = 0;
  for (let row = 1; row <= design.rowCount; row += 1) {
    const rowStart = offsetBy(origin, intoRock, design.burdenM * (row - 1));
    const stagger = design.layout === 'staggered' && row % 2 === 0 ? design.spacingM / 2 : 0;
    const positions = [];
    for (let index = 0; index < design.holesPerRow; index += 1) {
      positions.push(offsetBy(rowStart, alongFace, stagger + design.spacingM * index));
    }
    if (row % 2 === 0) {
      positions.reverse();
    }
    for (const collar of positions) {
      number += 1;
      holes.push({
        holeNumber: number,
        rowNumber: row,
        easting: roundTo(collar.easting, 3),
        northing: roundTo(collar.northing, 3),
        collarLevelM: roundTo(collar.level, 3),
        designedDepthM: roundTo(
          drilledLength({
            benchHeightM: design.benchHeightM,
            subdrillM: design.subdrillM,
            inclinationDeg: design.inclinationDeg,
          }),
          3,
        ),
        diameterMm: design.diameterMm,
        inclinationDeg: design.inclinationDeg,
        bearingDeg: design.inclinationDeg === 0 ? 0 : holeBearing,
      });
    }
  }
  return { holes, alongFaceBearingDeg: alongFace, intoRockBearingDeg: intoRock };
}

/** Rock each hole is responsible for, which is what a powder factor divides by. */
export function volumePerHole({ burdenM, spacingM, benchHeightM }) {
  requirePositive(burdenM, 'burdenM');
  requirePositive(spacingM, 'spacingM');
  requirePositive(benchHeightM, 'benchHeightM');
  return roundTo(burdenM * spacingM * benchHeightM, 3);
}

export function patternVolume({ burdenM, spacingM, benchHeightM, holeCount }) {
  requireWholeNumber(holeCount, 'holeCount');
  return roundTo(volumePerHole({ burdenM, spacingM, benchHeightM }) * holeCount, 3);
}

export function patternTonnes({ volumeM3, rockDensityKgM3 }) {
  requirePositive(volumeM3, 'volumeM3');
  requirePositive(rockDensityKgM3, 'rockDensityKgM3');
  return roundTo((volumeM3 * rockDensityKgM3) / 1000, 3);
}

/**
 * Spacing over burden. Below one the pattern is drilled long and thin and breaks
 * badly. Between 1.0 and 1.5 is the ordinary production window, and above 2 the
 * holes stop working together at all.
 */
export function spacingToBurdenRatio({ burdenM, spacingM }) {
  requirePositive(burdenM, 'burdenM');
  requirePositive(spacingM, 'spacingM');
  return roundTo(spacingM / burdenM, 3);
}

/** Bench height over burden. A stiff pattern is one under two and it throws badly. */
export function stiffnessRatio({ benchHeightM, burdenM }) {
  requirePositive(benchHeightM, 'benchHeightM');
  requirePositive(burdenM, 'burdenM');
  return roundTo(benchHeightM / burdenM, 3);
}

export function summarisePattern(design, holes) {
  const volume = patternVolume({
    burdenM: design.burdenM,
    spacingM: design.spacingM,
    benchHeightM: design.benchHeightM,
    holeCount: holes.length,
  });
  return {
    holeCount: holes.length,
    rowCount: new Set(holes.map((hole) => hole.rowNumber)).size,
    totalDrillingM: roundTo(
      holes.reduce((sum, hole) => sum + hole.designedDepthM, 0),
      2,
    ),
    volumeM3: volume,
    volumePerHoleM3: volumePerHole(design),
    spacingToBurden: spacingToBurdenRatio(design),
    stiffness: stiffnessRatio(design),
  };
}
