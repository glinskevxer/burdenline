import { describe, it, expect } from 'vitest';
import {
  powderFactor,
  specificCharge,
  anfoEquivalentKg,
  energyFactor,
  assess,
  byRow,
  distribution,
  POWDER_FACTOR_BANDS,
} from '../../../src/domain/charging/powder-factor.js';
import { ValidationError } from '../../../src/lib/errors.js';

describe('powderFactor', () => {
  it('divides charge by rock', () => {
    expect(powderFactor({ massKg: 86.6, volumeM3: 157.5 })).toBeCloseTo(0.5498, 4);
  });

  it('reads an unloaded pattern as zero rather than failing', () => {
    expect(powderFactor({ massKg: 0, volumeM3: 100 })).toBe(0);
  });

  it('refuses no rock and a negative charge', () => {
    expect(() => powderFactor({ massKg: 10, volumeM3: 0 })).toThrow(ValidationError);
    expect(() => powderFactor({ massKg: -10, volumeM3: 100 })).toThrow(ValidationError);
  });
});

describe('specificCharge', () => {
  it('reports kilograms a tonne', () => {
    expect(specificCharge({ massKg: 425, tonnes: 2000 })).toBe(0.2125);
  });

  it('refuses no tonnage', () => {
    expect(() => specificCharge({ massKg: 10, tonnes: 0 })).toThrow(ValidationError);
  });
});

describe('energy', () => {
  it('reads anfo as its own weight', () => {
    expect(anfoEquivalentKg([{ massKg: 100, relativeWeightStrength: 100 }])).toBe(100);
  });

  it('discounts a weaker emulsion', () => {
    expect(anfoEquivalentKg([{ massKg: 100, relativeWeightStrength: 82 }])).toBe(82);
  });

  it('assumes anfo when nothing says otherwise', () => {
    expect(anfoEquivalentKg([{ massKg: 50 }])).toBe(50);
  });

  it('adds a mixed load up', () => {
    expect(
      anfoEquivalentKg([
        { massKg: 60, relativeWeightStrength: 100 },
        { massKg: 40, relativeWeightStrength: 82 },
      ]),
    ).toBe(92.8);
  });

  it('reports an energy factor below the powder factor for weaker product', () => {
    const loads = [{ massKg: 100, relativeWeightStrength: 82 }];
    expect(energyFactor({ loads, volumeM3: 200 })).toBeLessThan(
      powderFactor({ massKg: 100, volumeM3: 200 }),
    );
  });

  it('refuses a strength of zero', () => {
    expect(() => anfoEquivalentKg([{ massKg: 10, relativeWeightStrength: 0 }])).toThrow(
      ValidationError,
    );
  });
});

describe('assess', () => {
  it('calls a normal medium rock pattern normal', () => {
    expect(assess(0.45, 'medium').verdict).toBe('normal');
  });

  it('calls a light pattern light', () => {
    expect(assess(0.2, 'medium').verdict).toBe('light');
  });

  it('calls a heavy pattern heavy', () => {
    expect(assess(0.7, 'medium').verdict).toBe('heavy');
  });

  it('moves the band with the rock', () => {
    expect(assess(0.5, 'soft').verdict).toBe('heavy');
    expect(assess(0.5, 'very_hard').verdict).toBe('light');
  });

  it('defaults to medium rock', () => {
    expect(assess(0.45).verdict).toBe('normal');
  });

  it('refuses a rock band nobody quarries', () => {
    expect(() => assess(0.4, 'squishy')).toThrow(ValidationError);
  });

  it('publishes the bands it judges against', () => {
    expect(POWDER_FACTOR_BANDS.hard.high).toBe(0.8);
    expect(Object.isFrozen(POWDER_FACTOR_BANDS)).toBe(true);
  });
});

describe('byRow', () => {
  const geometry = { burdenM: 3, spacingM: 3.5, benchHeightM: 15 };
  const holes = [
    { holeNumber: 1, rowNumber: 1, massKg: 100 },
    { holeNumber: 2, rowNumber: 1, massKg: 100 },
    { holeNumber: 3, rowNumber: 2, massKg: 80 },
    { holeNumber: 4, rowNumber: 2, massKg: 80 },
  ];

  it('groups the charge by row', () => {
    const rows = byRow(holes, geometry);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ rowNumber: 1, holeCount: 2, massKg: 200 });
  });

  it('works a powder factor out per row', () => {
    const rows = byRow(holes, geometry);
    expect(rows[0].powderFactorKgM3).toBeCloseTo(0.6349, 4);
    expect(rows[1].powderFactorKgM3).toBeCloseTo(0.5079, 4);
  });

  it('sorts the rows from the face back', () => {
    const reversed = [...holes].reverse();
    expect(byRow(reversed, geometry).map((row) => row.rowNumber)).toEqual([1, 2]);
  });

  it('treats a hole with no row as the front row', () => {
    expect(byRow([{ holeNumber: 1, massKg: 50 }], geometry)[0].rowNumber).toBe(1);
  });
});

describe('distribution', () => {
  const geometry = { burdenM: 3, spacingM: 3.5, benchHeightM: 15 };

  it('calls an even pattern even', () => {
    const rows = byRow(
      [
        { rowNumber: 1, massKg: 100 },
        { rowNumber: 2, massKg: 100 },
      ],
      geometry,
    );
    expect(distribution(rows).even).toBe(true);
    expect(distribution(rows).spread).toBe(0);
  });

  it('flags a front row carrying much more than the back', () => {
    const rows = byRow(
      [
        { rowNumber: 1, massKg: 140 },
        { rowNumber: 2, massKg: 90 },
      ],
      geometry,
    );
    const spread = distribution(rows);
    expect(spread.even).toBe(false);
    expect(spread.front).toBeGreaterThan(spread.back);
  });

  it('has nothing to say about no rows', () => {
    expect(distribution([])).toEqual({ spread: null, front: null, back: null, even: true });
  });
});
