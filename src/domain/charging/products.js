/**
 * The explosive product catalogue.
 *
 * A product is not just a density. It carries the water resistance that decides
 * whether it can go in a wet hole at all, the minimum diameter below which it
 * will not reliably detonate, the sleep time after which a pumped emulsion has
 * to be treated as suspect, and the classification that the magazine licence and
 * the carrier's paperwork are both written against.
 */

import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';

export const PRODUCT_KINDS = [
  'bulk_anfo',
  'bulk_emulsion',
  'bulk_blend',
  'packaged_emulsion',
  'cartridge',
  'booster',
  'detonator',
  'detonating_cord',
  'shock_tube',
];

export const WATER_RESISTANCE = ['none', 'limited', 'good', 'excellent'];

/** ANFO at 0.8 grams per cubic centimetre is the reference every strength is quoted against. */
export const ANFO_REFERENCE = Object.freeze({
  densityKgM3: 800,
  weightStrength: 100,
  bulkStrength: 100,
});

export const productSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(16)
    .regex(/^[A-Z0-9][A-Z0-9-]*$/, 'a product code is capitals, digits and hyphens'),
  name: z.string().min(3).max(80),
  kind: z.enum([
    'bulk_anfo',
    'bulk_emulsion',
    'bulk_blend',
    'packaged_emulsion',
    'cartridge',
    'booster',
    'detonator',
    'detonating_cord',
    'shock_tube',
  ]),
  densityKgM3: z.number().min(200).max(2000).nullable().default(null),
  relativeWeightStrength: z.number().min(10).max(200).nullable().default(null),
  velocityOfDetonationMs: z.number().min(1000).max(9000).nullable().default(null),
  waterResistance: z.enum(['none', 'limited', 'good', 'excellent']).default('none'),
  minimumDiameterMm: z.number().min(10).max(400).nullable().default(null),
  sleepTimeHours: z.number().int().min(0).max(2160).nullable().default(null),
  unNumber: z
    .string()
    .regex(/^UN\d{4}$/)
    .nullable()
    .default(null),
  hazardDivision: z.enum(['1.1D', '1.1B', '1.4B', '1.4S', '1.5D']).nullable().default(null),
  compatibilityGroup: z.enum(['B', 'D', 'S']).nullable().default(null),
  unitMassKg: z.number().positive().max(50).nullable().default(null),
  isExplosive: z.boolean().default(true),
});

export function parseProduct(input) {
  const parsed = productSchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the product is not usable');
  }
  const product = parsed.data;
  if (isBulk(product) && product.densityKgM3 === null) {
    throw new ValidationError('a bulk product needs a density', [
      { path: 'densityKgM3', message: 'required for a bulk product', kind: 'missing' },
    ]);
  }
  if (isCountable(product) && product.unitMassKg === null) {
    throw new ValidationError('a counted product needs a unit mass', [
      {
        path: 'unitMassKg',
        message: 'required for a packaged or counted product',
        kind: 'missing',
      },
    ]);
  }
  return Object.freeze(product);
}

export function isBulk(product) {
  return ['bulk_anfo', 'bulk_emulsion', 'bulk_blend'].includes(product.kind);
}

export function isCountable(product) {
  return ['packaged_emulsion', 'cartridge', 'booster', 'detonator'].includes(product.kind);
}

export function isInitiator(product) {
  return ['detonator', 'detonating_cord', 'shock_tube', 'booster'].includes(product.kind);
}

/** Relative bulk strength: energy per unit of hole filled, not per kilogram. */
export function relativeBulkStrength(product) {
  if (product.relativeWeightStrength === null || product.densityKgM3 === null) {
    return null;
  }
  return roundTo(
    ((product.relativeWeightStrength * product.densityKgM3) /
      (ANFO_REFERENCE.weightStrength * ANFO_REFERENCE.densityKgM3)) *
      100,
    1,
  );
}

/** Kilograms that fill one metre of a hole of the given diameter. */
export function kgPerMetre(product, diameterMm) {
  if (!isBulk(product) && product.kind !== 'packaged_emulsion') {
    throw new ValidationError(`${product.code} is not loaded by the metre`, [
      {
        path: 'kind',
        message: 'only bulk and packaged product fill a column',
        kind: 'unsupported',
      },
    ]);
  }
  const radius = diameterMm / 2000;
  return roundTo(Math.PI * radius * radius * product.densityKgM3, 4);
}

/**
 * Can this product go in this hole? Water resistance against the hole condition
 * and the diameter against the minimum are separate reasons and both are
 * reported, because a crew swapping product wants to know every constraint at
 * once rather than one at a time.
 */
export function suitability(product, hole) {
  const reasons = [];
  const condition = hole?.condition ?? 'dry';
  if (condition === 'wet' && !['good', 'excellent'].includes(product.waterResistance)) {
    reasons.push({
      rule: 'product.water_resistance',
      message: `${product.code} is not rated for a wet hole`,
    });
  }
  if (condition === 'damp' && product.waterResistance === 'none') {
    reasons.push({
      rule: 'product.water_resistance',
      message: `${product.code} has no water resistance and the hole is damp`,
    });
  }
  if (condition === 'cavity' && isBulk(product) && product.kind !== 'bulk_emulsion') {
    reasons.push({
      rule: 'product.cavity',
      message: `${product.code} runs into a cavity and cannot be metered`,
    });
  }
  const diameter = hole?.diameterMm ?? null;
  if (
    diameter !== null &&
    product.minimumDiameterMm !== null &&
    diameter < product.minimumDiameterMm
  ) {
    reasons.push({
      rule: 'product.minimum_diameter',
      message: `${product.code} needs at least ${product.minimumDiameterMm} mm and the hole is ${diameter} mm`,
    });
  }
  if (condition === 'collapsed' || condition === 'lost') {
    reasons.push({ rule: 'product.hole_lost', message: 'the hole cannot be charged at all' });
  }
  return { suitable: reasons.length === 0, reasons };
}

/** Products that will do, best water resistance first, then cheapest energy. */
export function selectForHole(products, hole) {
  return products
    .map((product) => ({ product, ...suitability(product, hole) }))
    .filter((candidate) => candidate.suitable)
    .map((candidate) => candidate.product)
    .sort((a, b) => {
      const resistance =
        WATER_RESISTANCE.indexOf(b.waterResistance) - WATER_RESISTANCE.indexOf(a.waterResistance);
      if (resistance !== 0) {
        return resistance;
      }
      return (a.relativeWeightStrength ?? 0) - (b.relativeWeightStrength ?? 0);
    });
}
