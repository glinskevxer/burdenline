/**
 * The products a designer may load a hole with, read out of the catalogue.
 *
 * The design route and the what-if route were each building this list, and the
 * two had already drifted on which kinds count as loadable, so a product that
 * could be planned into a shot could not be compared in a what-if.
 */

import { listProducts } from '../db/repositories/explosives.js';
import { parseProduct } from '../domain/charging/products.js';

/** The kinds that fill a column. Anything else is an accessory or an initiator. */
export const LOADABLE_KINDS = Object.freeze([
  'bulk_anfo',
  'bulk_emulsion',
  'bulk_blend',
  'packaged_emulsion',
]);

export function loadableCatalogue(db) {
  return listProducts(db)
    .filter((product) => LOADABLE_KINDS.includes(product.kind))
    .map((product) =>
      parseProduct({
        code: product.code,
        name: product.name,
        kind: product.kind,
        densityKgM3: product.densityKgM3,
        relativeWeightStrength: product.relativeWeightStrength,
        velocityOfDetonationMs: product.velocityOfDetonationMs,
        waterResistance: product.waterResistance,
        minimumDiameterMm: product.minimumDiameterMm,
        sleepTimeHours: product.sleepTimeHours,
      }),
    );
}
