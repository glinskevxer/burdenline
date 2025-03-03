/**
 * The drill plan that goes out to the rig.
 *
 * Two rig navigation systems are in use on the sites this runs on and neither
 * reads the other's file. The Atlas style file wants collar coordinates and a
 * depth; the Epiroc style file wants the toe as well and an explicit hole
 * identifier it can report back against. Both want the columns in a fixed order,
 * both truncate a long identifier, and the rig will happily drill the wrong hole
 * if the identifier collides, so identifiers are checked before the file is
 * written rather than after the crew is on the bench.
 */

import { ValidationError } from '../../lib/errors.js';
import { toCsv } from '../../lib/csv.js';
import { roundTo } from '../../lib/units.js';
import { describeHole } from '../geometry/hole.js';

export const PLAN_FORMATS = ['collar', 'collar_toe'];

const MAX_IDENTIFIER_LENGTH = 12;

export function holeIdentifier(patternReference, holeNumber) {
  const compact = String(patternReference).replace(/[^A-Za-z0-9]/g, '');
  const suffix = String(holeNumber).padStart(3, '0');
  const room = MAX_IDENTIFIER_LENGTH - suffix.length - 1;
  return `${compact.slice(-room)}-${suffix}`;
}

/** One row per hole in the shape the rig expects, before it is serialised. */
export function buildPlanRows(pattern, holes, { format = 'collar' } = {}) {
  if (!PLAN_FORMATS.includes(format)) {
    throw new ValidationError(`${format} is not a drill plan format`, [
      { path: 'format', message: `expected one of ${PLAN_FORMATS.join(', ')}`, kind: 'enum' },
    ]);
  }
  if (!Array.isArray(holes) || holes.length === 0) {
    throw new ValidationError('a drill plan needs at least one hole', [
      { path: 'holes', message: 'the pattern has no holes', kind: 'missing' },
    ]);
  }
  const identifiers = new Set();
  return holes.map((hole) => {
    const identifier = holeIdentifier(pattern.reference, hole.holeNumber);
    if (identifiers.has(identifier)) {
      throw new ValidationError(`two holes would be sent to the rig as ${identifier}`, [
        { path: 'holes', message: 'hole identifiers collide once truncated', kind: 'conflict' },
      ]);
    }
    identifiers.add(identifier);
    const described = describeHole({
      collar: {
        easting: hole.easting ?? hole.eastingM,
        northing: hole.northing ?? hole.northingM,
        level: hole.collarLevelM,
      },
      benchHeightM: pattern.benchHeightM,
      subdrillM: pattern.subdrillM ?? 0,
      inclinationDeg: hole.inclinationDeg ?? 0,
      bearingDeg: hole.bearingDeg ?? 0,
      diameterMm: hole.diameterMm,
    });
    const row = {
      id: identifier,
      hole: hole.holeNumber,
      row: hole.rowNumber,
      easting: roundTo(described.collar.easting, 2),
      northing: roundTo(described.collar.northing, 2),
      level: roundTo(described.collar.level, 2),
      depth: roundTo(hole.designedDepthM ?? described.lengthM, 2),
      diameter: hole.diameterMm,
      inclination: hole.inclinationDeg ?? 0,
      bearing: hole.bearingDeg ?? 0,
    };
    if (format === 'collar_toe') {
      row.toe_easting = roundTo(described.toe.easting, 2);
      row.toe_northing = roundTo(described.toe.northing, 2);
      row.toe_level = roundTo(described.toe.level, 2);
    }
    return row;
  });
}

const COLUMNS = {
  collar: [
    'id',
    'hole',
    'row',
    'easting',
    'northing',
    'level',
    'depth',
    'diameter',
    'inclination',
    'bearing',
  ],
  collar_toe: [
    'id',
    'hole',
    'row',
    'easting',
    'northing',
    'level',
    'toe_easting',
    'toe_northing',
    'toe_level',
    'depth',
    'diameter',
    'inclination',
    'bearing',
  ],
};

export function exportDrillPlan(pattern, holes, options = {}) {
  const format = options.format ?? 'collar';
  const rows = buildPlanRows(pattern, holes, { format });
  return toCsv(rows, { columns: COLUMNS[format], decimals: 2, newline: options.newline ?? '\r\n' });
}

/** What the crew is told before they take the file to the bench. */
export function planSummary(pattern, holes) {
  const rows = buildPlanRows(pattern, holes);
  const totalDepth = rows.reduce((sum, row) => sum + row.depth, 0);
  const diameters = [...new Set(rows.map((row) => row.diameter))].sort((a, b) => a - b);
  return {
    reference: pattern.reference,
    holeCount: rows.length,
    rowCount: new Set(rows.map((row) => row.row)).size,
    totalDrillingM: roundTo(totalDepth, 2),
    averageDepthM: roundTo(totalDepth / rows.length, 2),
    diametersMm: diameters,
    mixedDiameters: diameters.length > 1,
  };
}
