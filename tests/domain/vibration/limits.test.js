import { describe, it, expect } from 'vitest';
import {
  CURVES,
  curveNames,
  getCurve,
  limitAt,
  fixedLimit,
  evaluate,
  lowestLimit,
  curveForReceptor,
  limitForRecord,
} from '../../../src/domain/vibration/limits.js';
import { ValidationError } from '../../../src/lib/errors.js';

describe('the curve set', () => {
  it('carries both standards', () => {
    expect(curveNames()).toEqual([
      'usbm_drywall',
      'usbm_plaster',
      'din_sensitive',
      'din_residential',
      'din_commercial',
    ]);
    expect(getCurve('usbm_drywall').standard).toBe('USBM RI8507');
    expect(getCurve('din_residential').standard).toContain('DIN 4150-3');
  });

  it('is frozen so nothing can edit a standard at runtime', () => {
    expect(Object.isFrozen(CURVES)).toBe(true);
    expect(Object.isFrozen(CURVES.din_residential.points)).toBe(true);
  });

  it('refuses a curve it does not hold', () => {
    expect(() => getCurve('bs7385')).toThrow(ValidationError);
  });
});

describe('limitAt', () => {
  it('holds the German residential limit flat below ten hertz', () => {
    expect(limitAt('din_residential', 2)).toBe(5);
    expect(limitAt('din_residential', 10)).toBe(5);
  });

  it('interpolates the German curve linearly with frequency', () => {
    expect(limitAt('din_residential', 30)).toBe(10);
    expect(limitAt('din_residential', 75)).toBe(17.5);
  });

  it('holds the American curve at its plateau between four and fifteen hertz', () => {
    expect(limitAt('usbm_drywall', 4)).toBe(19.1);
    expect(limitAt('usbm_drywall', 15)).toBe(19.1);
    expect(limitAt('usbm_drywall', 8)).toBeCloseTo(19.1, 3);
  });

  it('drops the American limit sharply at low frequency', () => {
    expect(limitAt('usbm_drywall', 2)).toBeLessThan(limitAt('usbm_drywall', 4));
    expect(limitAt('usbm_drywall', 1)).toBe(5.1);
  });

  it('gives older plaster a lower allowance than plasterboard', () => {
    expect(limitAt('usbm_plaster', 10)).toBeLessThan(limitAt('usbm_drywall', 10));
  });

  it('gives a sensitive structure the lowest allowance of all', () => {
    expect(limitAt('din_sensitive', 8)).toBeLessThan(limitAt('din_residential', 8));
  });

  it('holds the curve flat past the last point rather than running away', () => {
    expect(limitAt('din_residential', 400)).toBe(20);
    expect(limitAt('usbm_drywall', 250)).toBe(50.8);
  });

  it('refuses a frequency of zero', () => {
    expect(() => limitAt('din_residential', 0)).toThrow(ValidationError);
  });
});

describe('fixedLimit', () => {
  it('takes a licence condition as a flat number', () => {
    expect(fixedLimit(6).limitMmPerSecond).toBe(6);
    expect(fixedLimit(6).standard).toBe('licence condition');
  });

  it('refuses a limit of zero', () => {
    expect(() => fixedLimit(0)).toThrow(ValidationError);
  });
});

describe('evaluate', () => {
  it('passes a reading under the curve', () => {
    const result = evaluate({ peakMmPerSecond: 3.2, frequencyHz: 22 }, getCurve('din_residential'));
    expect(result.compliant).toBe(true);
    expect(result.limitMmPerSecond).toBe(8);
    expect(result.ratio).toBeCloseTo(0.4, 3);
  });

  it('fails a reading over the curve and reports the shortfall', () => {
    const result = evaluate({ peakMmPerSecond: 9, frequencyHz: 8 }, getCurve('din_residential'));
    expect(result.compliant).toBe(false);
    expect(result.marginMmPerSecond).toBe(-4);
  });

  it('takes a flat licence limit over any curve', () => {
    const result = evaluate({ peakMmPerSecond: 7, frequencyHz: 60 }, fixedLimit(6));
    expect(result.compliant).toBe(false);
    expect(result.limitMmPerSecond).toBe(6);
  });

  it('judges a reading with no frequency against the worst point on the curve', () => {
    const result = evaluate({ peakMmPerSecond: 6 }, getCurve('din_residential'));
    expect(result.limitMmPerSecond).toBe(5);
    expect(result.assumedWorstFrequency).toBe(true);
    expect(result.compliant).toBe(false);
  });

  it('does not claim an assumption when the limit is flat anyway', () => {
    expect(evaluate({ peakMmPerSecond: 4 }, fixedLimit(6)).assumedWorstFrequency).toBe(false);
  });

  it('takes a curve by name as well as by object', () => {
    expect(
      evaluate({ peakMmPerSecond: 4, frequencyHz: 12 }, 'din_residential').limitMmPerSecond,
    ).toBe(5.5);
  });

  it('counts a reading exactly on the limit as compliant', () => {
    expect(evaluate({ peakMmPerSecond: 5, frequencyHz: 6 }, 'din_residential').compliant).toBe(
      true,
    );
  });
});

describe('lowestLimit', () => {
  it('finds the floor of a curve', () => {
    expect(lowestLimit('din_residential')).toBe(5);
    expect(lowestLimit('usbm_drywall')).toBe(5.1);
  });
});

describe('curveForReceptor', () => {
  it('sends a dwelling to the plasterboard curve', () => {
    expect(curveForReceptor({ structureClass: 'dwelling' }).name).toBe('usbm_drywall');
  });

  it('sends an older dwelling to the plaster curve', () => {
    expect(curveForReceptor({ structureClass: 'older_dwelling' }).name).toBe('usbm_plaster');
  });

  it('sends a listed building to the sensitive curve', () => {
    expect(curveForReceptor({ structureClass: 'listed' }).name).toBe('din_sensitive');
  });

  it('lets a receptor carry its own licence limit', () => {
    const limit = curveForReceptor({ structureClass: 'dwelling', limitMmPerSecond: 4 });
    expect(limit.limitMmPerSecond).toBe(4);
  });

  it('refuses a structure class nobody has set a curve for', () => {
    expect(() => curveForReceptor({ structureClass: 'barn' })).toThrow(ValidationError);
  });
});

describe('limitForRecord', () => {
  const record = { peakMmPerSecond: 4.2, peakFrequencyHz: 22 };

  it('reads the curve at the frequency the record carries', () => {
    expect(limitForRecord(record, { structureClass: 'dwelling' })).toBe(
      limitAt('usbm_drywall', 22),
    );
  });

  it('takes a licence limit over the curve', () => {
    expect(limitForRecord(record, { structureClass: 'dwelling', limitMmPerSecond: 6 })).toBe(6);
  });

  it('falls to the floor of the curve when the record has no frequency', () => {
    expect(limitForRecord({ peakMmPerSecond: 4.2 }, { structureClass: 'dwelling' })).toBe(
      lowestLimit('usbm_drywall'),
    );
  });

  it('has no limit for a record from no receptor at all', () => {
    expect(limitForRecord(record, null)).toBe(null);
  });

  it('gives a listed building a tighter limit than a dwelling for the same record', () => {
    expect(limitForRecord(record, { structureClass: 'listed' })).toBeLessThan(
      limitForRecord(record, { structureClass: 'dwelling' }),
    );
  });
});
