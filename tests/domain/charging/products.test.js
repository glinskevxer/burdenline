import { describe, it, expect } from 'vitest';
import {
  parseProduct,
  isBulk,
  isCountable,
  isInitiator,
  relativeBulkStrength,
  kgPerMetre,
  suitability,
  selectForHole,
  PRODUCT_KINDS,
  WATER_RESISTANCE,
  ANFO_REFERENCE,
} from '../../../src/domain/charging/products.js';
import { ValidationError } from '../../../src/lib/errors.js';

const anfo = {
  code: 'ANFO-80',
  name: 'Ammonium nitrate fuel oil, poured',
  kind: 'bulk_anfo',
  densityKgM3: 800,
  relativeWeightStrength: 100,
  velocityOfDetonationMs: 3200,
  waterResistance: 'none',
  minimumDiameterMm: 50,
  unNumber: 'UN0331',
  hazardDivision: '1.5D',
  compatibilityGroup: 'D',
};

const emulsion = {
  code: 'EM-115',
  name: 'Pumped emulsion, gassed',
  kind: 'bulk_emulsion',
  densityKgM3: 1150,
  relativeWeightStrength: 82,
  velocityOfDetonationMs: 5200,
  waterResistance: 'excellent',
  minimumDiameterMm: 76,
  sleepTimeHours: 72,
  unNumber: 'UN0241',
  hazardDivision: '1.5D',
  compatibilityGroup: 'D',
};

const booster = {
  code: 'BST-400',
  name: 'Cast pentolite booster 400 g',
  kind: 'booster',
  unitMassKg: 0.4,
  velocityOfDetonationMs: 7400,
  waterResistance: 'excellent',
  unNumber: 'UN0042',
  hazardDivision: '1.1D',
  compatibilityGroup: 'D',
};

describe('parseProduct', () => {
  it('takes a bulk product and freezes it', () => {
    const product = parseProduct(anfo);
    expect(product.code).toBe('ANFO-80');
    expect(Object.isFrozen(product)).toBe(true);
  });

  it('defaults the fields a simple product leaves out', () => {
    const product = parseProduct({ ...booster, waterResistance: undefined });
    expect(product.waterResistance).toBe('none');
    expect(product.sleepTimeHours).toBe(null);
    expect(product.isExplosive).toBe(true);
  });

  it('refuses a lowercase product code', () => {
    expect(() => parseProduct({ ...anfo, code: 'anfo-80' })).toThrow(ValidationError);
  });

  it('refuses a bulk product with no density', () => {
    expect(() => parseProduct({ ...anfo, densityKgM3: null })).toThrow(/needs a density/);
  });

  it('refuses a counted product with no unit mass', () => {
    expect(() => parseProduct({ ...booster, unitMassKg: null })).toThrow(/unit mass/);
  });

  it('refuses a UN number that is not one', () => {
    expect(() => parseProduct({ ...anfo, unNumber: '0331' })).toThrow(ValidationError);
  });

  it('refuses a hazard division that is not an explosives one', () => {
    expect(() => parseProduct({ ...anfo, hazardDivision: '2.1' })).toThrow(ValidationError);
  });
});

describe('the kind of thing a product is', () => {
  it('knows what is pumped and what is counted', () => {
    expect(isBulk(parseProduct(anfo))).toBe(true);
    expect(isBulk(parseProduct(booster))).toBe(false);
    expect(isCountable(parseProduct(booster))).toBe(true);
    expect(isInitiator(parseProduct(booster))).toBe(true);
    expect(isInitiator(parseProduct(emulsion))).toBe(false);
  });

  it('lists every kind the catalogue holds', () => {
    expect(PRODUCT_KINDS).toContain('shock_tube');
    expect(PRODUCT_KINDS).toHaveLength(9);
  });
});

describe('strength', () => {
  it('reads anfo as the reference in both senses', () => {
    expect(relativeBulkStrength(parseProduct(anfo))).toBe(100);
    expect(ANFO_REFERENCE.densityKgM3).toBe(800);
  });

  it('reads a heavier emulsion as stronger by volume and weaker by weight', () => {
    const product = parseProduct(emulsion);
    expect(product.relativeWeightStrength).toBeLessThan(100);
    expect(relativeBulkStrength(product)).toBeGreaterThan(100);
    expect(relativeBulkStrength(product)).toBeCloseTo(117.9, 1);
  });

  it('has no answer for a product with no density', () => {
    expect(relativeBulkStrength(parseProduct(booster))).toBe(null);
  });
});

describe('kgPerMetre', () => {
  it('fills a 102 millimetre hole with anfo', () => {
    expect(kgPerMetre(parseProduct(anfo), 102)).toBeCloseTo(6.537, 3);
  });

  it('puts more emulsion in the same hole', () => {
    expect(kgPerMetre(parseProduct(emulsion), 102)).toBeGreaterThan(
      kgPerMetre(parseProduct(anfo), 102),
    );
  });

  it('refuses to fill a column with boosters', () => {
    expect(() => kgPerMetre(parseProduct(booster), 102)).toThrow(/not loaded by the metre/);
  });
});

describe('suitability', () => {
  it('lets anfo into a dry hole', () => {
    expect(suitability(parseProduct(anfo), { condition: 'dry', diameterMm: 102 }).suitable).toBe(
      true,
    );
  });

  it('keeps anfo out of a wet hole', () => {
    const result = suitability(parseProduct(anfo), { condition: 'wet', diameterMm: 102 });
    expect(result.suitable).toBe(false);
    expect(result.reasons[0].rule).toBe('product.water_resistance');
  });

  it('keeps a product with no water resistance out of a damp hole', () => {
    expect(suitability(parseProduct(anfo), { condition: 'damp', diameterMm: 102 }).suitable).toBe(
      false,
    );
  });

  it('lets emulsion into a wet hole', () => {
    expect(
      suitability(parseProduct(emulsion), { condition: 'wet', diameterMm: 102 }).suitable,
    ).toBe(true);
  });

  it('keeps poured product out of a hole with a cavity', () => {
    expect(suitability(parseProduct(anfo), { condition: 'cavity', diameterMm: 102 }).suitable).toBe(
      false,
    );
    expect(
      suitability(parseProduct(emulsion), { condition: 'cavity', diameterMm: 102 }).suitable,
    ).toBe(true);
  });

  it('refuses a hole too small for the product to fire in', () => {
    const result = suitability(parseProduct(emulsion), { condition: 'dry', diameterMm: 64 });
    expect(result.reasons.map((reason) => reason.rule)).toContain('product.minimum_diameter');
  });

  it('reports every reason at once', () => {
    const result = suitability(parseProduct(anfo), { condition: 'wet', diameterMm: 38 });
    expect(result.reasons).toHaveLength(2);
  });

  it('refuses any product for a lost hole', () => {
    expect(
      suitability(parseProduct(emulsion), { condition: 'lost', diameterMm: 102 }).suitable,
    ).toBe(false);
  });
});

describe('selectForHole', () => {
  const catalogue = [parseProduct(anfo), parseProduct(emulsion)];

  it('offers both products for a dry hole, water resistance first', () => {
    const options = selectForHole(catalogue, { condition: 'dry', diameterMm: 102 });
    expect(options.map((product) => product.code)).toEqual(['EM-115', 'ANFO-80']);
  });

  it('offers only the emulsion for a wet hole', () => {
    const options = selectForHole(catalogue, { condition: 'wet', diameterMm: 102 });
    expect(options.map((product) => product.code)).toEqual(['EM-115']);
  });

  it('offers nothing for a hole nothing fits', () => {
    expect(selectForHole(catalogue, { condition: 'wet', diameterMm: 38 })).toEqual([]);
  });

  it('lists water resistance from none to excellent', () => {
    expect(WATER_RESISTANCE).toEqual(['none', 'limited', 'good', 'excellent']);
  });
});
