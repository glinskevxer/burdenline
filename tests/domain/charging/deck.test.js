import { describe, it, expect } from 'vitest';
import {
  deckMassKg,
  deckLengthM,
  buildColumn,
  depthsFromCollar,
  validateColumn,
  DECK_KINDS,
} from '../../../src/domain/charging/deck.js';
import { parseProduct } from '../../../src/domain/charging/products.js';
import { ValidationError } from '../../../src/lib/errors.js';

const anfo = parseProduct({
  code: 'ANFO-80',
  name: 'Ammonium nitrate fuel oil',
  kind: 'bulk_anfo',
  densityKgM3: 800,
  relativeWeightStrength: 100,
  waterResistance: 'none',
});

const emulsion = parseProduct({
  code: 'EM-115',
  name: 'Pumped emulsion',
  kind: 'bulk_emulsion',
  densityKgM3: 1150,
  relativeWeightStrength: 82,
  waterResistance: 'excellent',
});

describe('mass and length of a deck', () => {
  it('converts a length of anfo into kilograms', () => {
    expect(deckMassKg(anfo, 102, 10)).toBeCloseTo(65.37, 2);
  });

  it('converts kilograms back into a length', () => {
    expect(deckLengthM(anfo, 102, 65.37)).toBeCloseTo(10, 2);
  });

  it('refuses a zero or negative length', () => {
    expect(() => deckMassKg(anfo, 102, 0)).toThrow(ValidationError);
    expect(() => deckLengthM(anfo, 102, -5)).toThrow(ValidationError);
  });
});

describe('buildColumn', () => {
  const base = { holeLengthM: 16, diameterMm: 102, stemmingM: 3 };

  it('puts the charge at the bottom and the stemming at the top', () => {
    const column = buildColumn({ ...base, charges: [{ product: anfo, lengthM: 13 }] });
    expect(column.decks.map((deck) => deck.kind)).toEqual(['charge', 'stemming']);
    expect(column.decks[0].fromToeM).toBe(0);
    expect(column.decks[1].toToeM).toBe(16);
  });

  it('works the mass out from the length', () => {
    const column = buildColumn({ ...base, charges: [{ product: anfo, lengthM: 13 }] });
    expect(column.totalMassKg).toBeCloseTo(84.98, 2);
  });

  it('works the length out from the mass', () => {
    const column = buildColumn({ ...base, charges: [{ product: anfo, massKg: 84.98 }] });
    expect(column.chargeLengthM).toBeCloseTo(13, 2);
  });

  it('refuses a charge given both ways', () => {
    expect(() =>
      buildColumn({ ...base, charges: [{ product: anfo, massKg: 80, lengthM: 12 }] }),
    ).toThrow(/not both/);
  });

  it('refuses a charge given neither way', () => {
    expect(() => buildColumn({ ...base, charges: [{ product: anfo }] })).toThrow(
      /mass or a length/,
    );
  });

  it('primes the bottom deck by default', () => {
    const column = buildColumn({ ...base, charges: [{ product: anfo, lengthM: 13 }] });
    expect(column.decks[0].primed).toBe(true);
    expect(column.decks[0].boosterCount).toBe(1);
  });

  it('builds a decked column with an inert gap between the charges', () => {
    const column = buildColumn({
      ...base,
      stemmingM: 3,
      charges: [
        { product: emulsion, lengthM: 5 },
        { gapM: 2, product: anfo, lengthM: 6, primed: true },
      ],
    });
    expect(column.decks.map((deck) => deck.kind)).toEqual([
      'charge',
      'inert',
      'charge',
      'stemming',
    ]);
    expect(column.decks[1].fromToeM).toBe(5);
    expect(column.decks[2].fromToeM).toBe(7);
  });

  it('leaves an air gap when the charges and stemming do not fill the hole', () => {
    const column = buildColumn({
      ...base,
      stemmingM: 3,
      charges: [{ product: anfo, lengthM: 10 }],
    });
    expect(column.airGapM).toBe(3);
    expect(column.decks.map((deck) => deck.kind)).toEqual(['charge', 'air', 'stemming']);
  });

  it('refuses a column longer than the hole', () => {
    expect(() => buildColumn({ ...base, charges: [{ product: anfo, lengthM: 17 }] })).toThrow(
      /longer than the hole/,
    );
  });

  it('refuses stemming that will not fit above the charge', () => {
    expect(() =>
      buildColumn({ ...base, stemmingM: 4, charges: [{ product: anfo, lengthM: 13 }] }),
    ).toThrow(/not enough hole left/);
  });

  it('refuses negative stemming and an empty charge list', () => {
    expect(() =>
      buildColumn({ ...base, stemmingM: -1, charges: [{ product: anfo, lengthM: 5 }] }),
    ).toThrow(ValidationError);
    expect(() => buildColumn({ ...base, charges: [] })).toThrow(/at least one charge/);
  });

  it('takes a hole with no stemming at all, which a trim shot uses', () => {
    const column = buildColumn({
      ...base,
      stemmingM: 0,
      charges: [{ product: anfo, lengthM: 16 }],
    });
    expect(column.decks.map((deck) => deck.kind)).toEqual(['charge']);
    expect(column.stemmingM).toBe(0);
  });
});

describe('depthsFromCollar', () => {
  it('turns toe distances into the depths the loader measures', () => {
    const column = buildColumn({
      holeLengthM: 16,
      diameterMm: 102,
      stemmingM: 3,
      charges: [{ product: anfo, lengthM: 13 }],
    });
    const depths = depthsFromCollar(column);
    expect(depths[1]).toMatchObject({ kind: 'stemming', fromCollarM: 0, toCollarM: 3 });
    expect(depths[0]).toMatchObject({ kind: 'charge', fromCollarM: 3, toCollarM: 16 });
  });
});

describe('validateColumn', () => {
  const good = buildColumn({
    holeLengthM: 16,
    diameterMm: 102,
    stemmingM: 3,
    charges: [{ product: anfo, lengthM: 13 }],
  });

  it('passes a column that was built properly', () => {
    expect(validateColumn(good)).toEqual({ valid: true, violations: [] });
  });

  it('spots a gap left by an edited deck', () => {
    const broken = {
      ...good,
      decks: [{ ...good.decks[0], toToeM: 12, lengthM: 12 }, good.decks[1]],
    };
    const result = validateColumn(broken);
    expect(result.valid).toBe(false);
    expect(result.violations.map((violation) => violation.rule)).toContain('column.gap');
  });

  it('spots two decks on top of each other', () => {
    const broken = {
      ...good,
      decks: [good.decks[0], { ...good.decks[1], fromToeM: 11, lengthM: 5 }],
    };
    expect(validateColumn(broken).violations.map((v) => v.rule)).toContain('column.overlap');
  });

  it('spots a column that does not reach the collar', () => {
    const broken = { ...good, decks: [good.decks[0]] };
    expect(validateColumn(broken).violations.map((v) => v.rule)).toContain('column.short');
  });

  it('spots a column with nothing primed', () => {
    const broken = {
      ...good,
      decks: [{ ...good.decks[0], primed: false }, good.decks[1]],
    };
    expect(validateColumn(broken).violations.map((v) => v.rule)).toContain('column.unprimed');
  });
});

describe('the deck vocabulary', () => {
  it('names every kind of deck a column holds', () => {
    expect(DECK_KINDS).toEqual(['charge', 'stemming', 'air', 'inert']);
  });
});
