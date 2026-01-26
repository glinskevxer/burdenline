import { describe, it, expect } from 'vitest';
import {
  tonnesFrom,
  volumeFrom,
  reconcileVolume,
  reconcileTonnage,
  preferredSurvey,
  digRate,
  yieldOf,
  SURVEY_METHODS,
  METHOD_CONFIDENCE,
} from '../../../src/domain/production/survey.js';
import { ValidationError } from '../../../src/lib/errors.js';

describe('mass and volume', () => {
  it('converts one to the other', () => {
    expect(tonnesFrom({ volumeM3: 1000, densityKgM3: 2700 })).toBe(2700);
    expect(volumeFrom({ tonnes: 2700, densityKgM3: 2700 })).toBe(1000);
  });

  it('refuses a density of nothing', () => {
    expect(() => tonnesFrom({ volumeM3: 1000, densityKgM3: 0 })).toThrow(ValidationError);
  });
});

describe('reconcileVolume', () => {
  it('calls a survey close to the design as designed', () => {
    const result = reconcileVolume({ designedM3: 3780, surveyedM3: 3900 });
    expect(result.verdict).toBe('as_designed');
    expect(result.withinTolerance).toBe(true);
    expect(result.overbreakM3).toBe(120);
  });

  it('calls a much larger survey overbreak', () => {
    expect(reconcileVolume({ designedM3: 3780, surveyedM3: 4600 }).verdict).toBe('overbreak');
  });

  it('calls a much smaller one underbreak', () => {
    expect(reconcileVolume({ designedM3: 3780, surveyedM3: 3000 }).verdict).toBe('underbreak');
  });

  it('follows a tighter tolerance', () => {
    const strict = reconcileVolume({ designedM3: 3780, surveyedM3: 3900, toleranceFraction: 0.01 });
    expect(strict.withinTolerance).toBe(false);
  });

  it('refuses a design of nothing', () => {
    expect(() => reconcileVolume({ designedM3: 0, surveyedM3: 100 })).toThrow(ValidationError);
  });
});

describe('reconcileTonnage', () => {
  it('compares the weighbridge against the survey', () => {
    const result = reconcileTonnage({ surveyedM3: 1000, densityKgM3: 2700, truckedTonnes: 2650 });
    expect(result.expectedTonnes).toBe(2700);
    expect(result.differenceTonnes).toBe(-50);
    expect(result.withinTolerance).toBe(true);
  });

  it('flags a gap too wide to be spillage', () => {
    const result = reconcileTonnage({ surveyedM3: 1000, densityKgM3: 2700, truckedTonnes: 2100 });
    expect(result.withinTolerance).toBe(false);
  });

  it('takes a shot where nothing has moved yet', () => {
    const result = reconcileTonnage({ surveyedM3: 1000, densityKgM3: 2700, truckedTonnes: 0 });
    expect(result.differenceFraction).toBe(-1);
  });
});

describe('preferredSurvey', () => {
  const surveys = [
    { id: 'a', method: 'truck_count', volumeM3: 4100, surveyedAt: '2026-01-20T09:00:00.000Z' },
    { id: 'b', method: 'laser_scan', volumeM3: 3900, surveyedAt: '2026-01-18T09:00:00.000Z' },
    { id: 'c', method: 'total_station', volumeM3: 3950, surveyedAt: '2026-01-19T09:00:00.000Z' },
  ];

  it('takes the method that can be trusted most, not the newest', () => {
    expect(preferredSurvey(surveys).id).toBe('b');
  });

  it('breaks a tie on the later survey', () => {
    const twoScans = [
      { id: 'a', method: 'laser_scan', volumeM3: 3900, surveyedAt: '2026-01-18T09:00:00.000Z' },
      { id: 'b', method: 'laser_scan', volumeM3: 3940, surveyedAt: '2026-01-21T09:00:00.000Z' },
    ];
    expect(preferredSurvey(twoScans).id).toBe('b');
  });

  it('has nothing to prefer when nothing was surveyed', () => {
    expect(preferredSurvey([])).toBe(null);
    expect(preferredSurvey(undefined)).toBe(null);
  });

  it('publishes the methods and how far each is trusted', () => {
    expect(SURVEY_METHODS).toContain('drone_photogrammetry');
    expect(METHOD_CONFIDENCE.laser_scan).toBeGreaterThan(METHOD_CONFIDENCE.truck_count);
  });
});

describe('digRate', () => {
  const records = [
    {
      recordedOn: '2026-01-17',
      tonnes: 1400,
      hours: 8,
      delayMinutes: 30,
      delayReason: 'crusher stopped',
    },
    { recordedOn: '2026-01-18', tonnes: 1650, hours: 9, delayMinutes: 0 },
    {
      recordedOn: '2026-01-18',
      tonnes: 300,
      hours: 2,
      delayMinutes: 45,
      delayReason: 'waiting on trucks',
    },
  ];

  it('adds the tonnes and the hours up', () => {
    const rate = digRate(records);
    expect(rate.tonnes).toBe(3350);
    expect(rate.hours).toBe(19);
    expect(rate.tonnesPerHour).toBeCloseTo(176.32, 2);
  });

  it('counts the days worked rather than the records', () => {
    expect(digRate(records).days).toBe(2);
  });

  it('works out how much of the scheduled time was actually digging', () => {
    expect(digRate(records).availability).toBeCloseTo(0.938, 3);
  });

  it('groups the delays by what caused them', () => {
    expect(digRate(records).delaysByReason).toEqual({
      'crusher stopped': 30,
      'waiting on trucks': 45,
    });
  });

  it('records a delay with no reason as not recorded', () => {
    const rate = digRate([{ recordedOn: '2026-01-17', tonnes: 100, hours: 1, delayMinutes: 20 }]);
    expect(rate.delaysByReason['not recorded']).toBe(20);
  });

  it('has nothing to say before anything is dug', () => {
    expect(digRate([])).toMatchObject({ tonnes: 0, tonnesPerHour: null, days: 0 });
  });
});

describe('yieldOf', () => {
  const surveys = [
    { id: 'a', method: 'laser_scan', volumeM3: 3900, surveyedAt: '2026-01-18T09:00:00.000Z' },
  ];
  const digRecords = [{ recordedOn: '2026-01-18', tonnes: 5000, hours: 9, delayMinutes: 0 }];

  it('puts the design, the survey and the digging together', () => {
    const result = yieldOf({ designedM3: 3780, surveys, digRecords });
    expect(result.surveyedM3).toBe(3900);
    expect(result.volume.verdict).toBe('as_designed');
    expect(result.digging.tonnesPerHour).toBeCloseTo(555.56, 2);
    expect(result.tonnes).toBe(10530);
  });

  it('compares the weighbridge when there is one', () => {
    const result = yieldOf({ designedM3: 3780, surveys, digRecords, truckedTonnes: 10300 });
    expect(result.tonnage.withinTolerance).toBe(true);
  });

  it('leaves the comparisons out when there is no survey', () => {
    const result = yieldOf({ designedM3: 3780, surveys: [], digRecords });
    expect(result.volume).toBe(null);
    expect(result.tonnes).toBe(null);
  });

  it('refuses to work anything out from nothing at all', () => {
    expect(() => yieldOf({ surveys: [], digRecords: [] })).toThrow(ValidationError);
  });
});
