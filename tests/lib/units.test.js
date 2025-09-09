import { describe, it, expect } from 'vitest';
import {
  mmToMetres,
  metresToMm,
  feetToMetres,
  metresToFeet,
  tonnesToKg,
  kgToTonnes,
  poundsToKg,
  kgToPounds,
  gramsPerCcToKgPerM3,
  kgPerM3ToGramsPerCc,
  inchesPerSecondToMmPerSecond,
  mmPerSecondToInchesPerSecond,
  pascalsToDecibels,
  decibelsToPascals,
  roundTo,
  ceilToStep,
  clamp,
} from '../../src/lib/units.js';
import { ValidationError } from '../../src/lib/errors.js';

describe('length conversions', () => {
  it('turns a 102 mm hole diameter into metres', () => {
    expect(mmToMetres(102)).toBeCloseTo(0.102, 9);
  });

  it('round trips through millimetres', () => {
    expect(metresToMm(mmToMetres(89))).toBeCloseTo(89, 9);
  });

  it('converts a 40 foot bench to metres', () => {
    expect(feetToMetres(40)).toBeCloseTo(12.192, 6);
  });

  it('round trips through feet', () => {
    expect(metresToFeet(feetToMetres(31.5))).toBeCloseTo(31.5, 9);
  });
});

describe('mass conversions', () => {
  it('converts tonnes to kilograms', () => {
    expect(tonnesToKg(2.4)).toBe(2400);
  });

  it('converts kilograms back to tonnes', () => {
    expect(kgToTonnes(4500)).toBe(4.5);
  });

  it('converts a 50 pound bag to kilograms', () => {
    expect(poundsToKg(50)).toBeCloseTo(22.6796, 4);
  });

  it('round trips through pounds', () => {
    expect(kgToPounds(poundsToKg(25))).toBeCloseTo(25, 9);
  });
});

describe('density conversions', () => {
  it('reads an emulsion data sheet in kilograms per cubic metre', () => {
    expect(gramsPerCcToKgPerM3(1.15)).toBeCloseTo(1150, 9);
  });

  it('reads it back', () => {
    expect(kgPerM3ToGramsPerCc(820)).toBeCloseTo(0.82, 9);
  });
});

describe('vibration and airblast conversions', () => {
  it('converts half an inch per second to millimetres per second', () => {
    expect(inchesPerSecondToMmPerSecond(0.5)).toBeCloseTo(12.7, 6);
  });

  it('round trips a monitor reading', () => {
    expect(mmPerSecondToInchesPerSecond(inchesPerSecondToMmPerSecond(0.28))).toBeCloseTo(0.28, 9);
  });

  it('puts 120 decibels near two pascals', () => {
    expect(decibelsToPascals(120)).toBeCloseTo(20, 6);
  });

  it('round trips overpressure through decibels', () => {
    expect(pascalsToDecibels(decibelsToPascals(133))).toBeCloseTo(133, 9);
  });

  it('refuses a non positive overpressure', () => {
    expect(() => pascalsToDecibels(0)).toThrow(RangeError);
    expect(() => pascalsToDecibels(-3)).toThrow(RangeError);
  });
});

describe('rounding', () => {
  it('rounds half away from zero rather than half up', () => {
    expect(roundTo(2.5, 0)).toBe(3);
    expect(roundTo(-2.5, 0)).toBe(-3);
  });

  it('keeps three decimals by default', () => {
    expect(roundTo(12.34567)).toBe(12.346);
  });

  it('rejects a silly decimal count', () => {
    expect(() => roundTo(1, 20)).toThrow(RangeError);
    expect(() => roundTo(1, 1.5)).toThrow(RangeError);
  });

  it('steps up to a whole carton', () => {
    expect(ceilToStep(41, 25)).toBe(50);
    expect(ceilToStep(50, 25)).toBe(50);
  });

  it('does not step up on a float artefact', () => {
    expect(ceilToStep(0.1 + 0.2, 0.3)).toBeCloseTo(0.3, 9);
  });

  it('refuses a zero step', () => {
    expect(() => ceilToStep(10, 0)).toThrow(RangeError);
  });
});

describe('clamp', () => {
  it('holds a value inside the range', () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-4, 1, 10)).toBe(1);
    expect(clamp(44, 1, 10)).toBe(10);
  });

  it('refuses an inverted range', () => {
    expect(() => clamp(5, 10, 1)).toThrow(RangeError);
  });
});

describe('argument checking', () => {
  it('rejects anything that is not a finite number and names the argument', () => {
    expect(() => mmToMetres('102')).toThrow(ValidationError);
    expect(() => tonnesToKg(Number.NaN)).toThrow(ValidationError);
    expect(() => clamp(Number.POSITIVE_INFINITY, 0, 1)).toThrow(ValidationError);
    try {
      mmToMetres('102');
    } catch (error) {
      expect(error.issues[0].path).toBe('mm');
    }
  });
});
