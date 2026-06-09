/**
 * The facts about a shot that three different reports all needed.
 *
 * The shot report, the period report and the productivity report were each
 * reading the drilled metres and the explosive off the same two tables in
 * slightly different ways, and they had already drifted: one counted issues and
 * one counted consumption, so a shot with a return against it appeared in two
 * reports with two different figures for the same explosive.
 */

import { roundTo } from '../../lib/units.js';
import { listHoles } from './patterns.js';
import { ledgerForBlast } from './explosives.js';

/** Metres actually drilled, falling back to the design where the rig said nothing. */
export function metresDrilled(db, patternId) {
  if (!patternId) {
    return 0;
  }
  return roundTo(
    listHoles(db, patternId, { limit: 1000 }).reduce(
      (sum, hole) => sum + (hole.drilledDepthM ?? hole.designedDepthM ?? 0),
      0,
    ),
    2,
  );
}

/**
 * What went down the holes, per product. Consumption where it has been recorded,
 * and issues net of returns where it has not, so a site that does not fill the
 * consumption records in still gets a figure rather than a zero.
 */
export function explosiveUsed(db, blastId) {
  const lines = ledgerForBlast(db, blastId);
  const consumption = group(lines.filter((line) => line.movement === 'consumption'));
  if (consumption.length > 0) {
    return { source: 'consumption', products: consumption };
  }
  const issued = group(lines.filter((line) => line.movement === 'issue'));
  const returned = new Map(
    group(lines.filter((line) => line.movement === 'return')).map((item) => [
      item.productCode,
      item.quantity,
    ]),
  );
  return {
    source: issued.length > 0 ? 'issued_less_returns' : 'nothing_recorded',
    products: issued.map((item) => ({
      ...item,
      quantity: roundTo(item.quantity - (returned.get(item.productCode) ?? 0), 3),
    })),
  };
}

export function totalExplosiveKg(db, blastId) {
  return roundTo(
    explosiveUsed(db, blastId).products.reduce(
      (sum, item) => sum + (item.unit === 'kg' ? item.quantity : 0),
      0,
    ),
    3,
  );
}

function group(lines) {
  const byProduct = new Map();
  for (const line of lines) {
    const current = byProduct.get(line.productCode) ?? {
      productCode: line.productCode,
      unit: line.unit,
      quantity: 0,
    };
    current.quantity = roundTo(current.quantity + Math.abs(line.quantity), 4);
    byProduct.set(line.productCode, current);
  }
  return [...byProduct.values()].sort((a, b) => a.productCode.localeCompare(b.productCode));
}
