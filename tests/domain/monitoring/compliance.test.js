import { describe, it, expect } from 'vitest';
import {
  severityFor,
  evaluateRecord,
  evaluateAll,
  exceedances,
  repeatExceedances,
  complianceSummary,
  highestReading,
  SEVERITIES,
  DEFAULT_THRESHOLDS,
} from '../../../src/domain/monitoring/compliance.js';
import { parseRecord } from '../../../src/domain/monitoring/records.js';
import { parseReceptor } from '../../../src/domain/receptors/registry.js';
import { ValidationError } from '../../../src/lib/errors.js';

const cottage = parseReceptor({
  id: 'rec_1',
  name: 'Keeper cottage',
  structureClass: 'dwelling',
  easting: 1200,
  northing: 2000,
});

function record(overrides = {}) {
  return parseRecord({
    monitorSerial: 'BE-11482',
    receptorId: 'rec_1',
    triggeredAt: '2025-05-22T13:04:11.000Z',
    distanceM: 412,
    longitudinal: { peakMmPerSecond: 2.4, frequencyHz: 18 },
    transverse: { peakMmPerSecond: 3.1, frequencyHz: 14 },
    vertical: { peakMmPerSecond: 1.9, frequencyHz: 26 },
    airblastDb: 112.4,
    triggerLevelMmPerSecond: 0.5,
    ...overrides,
  });
}

describe('severityFor', () => {
  it('bands a ratio', () => {
    expect(severityFor(0.2)).toBe('none');
    expect(severityFor(0.8)).toBe('watch');
    expect(severityFor(0.95)).toBe('approaching');
    expect(severityFor(1.4)).toBe('exceedance');
  });

  it('counts a reading exactly on the limit as compliant', () => {
    expect(severityFor(1)).toBe('approaching');
  });

  it('follows thresholds the site sets', () => {
    expect(severityFor(0.6, { watch: 0.5, approaching: 0.8 })).toBe('watch');
  });

  it('orders the bands', () => {
    expect(SEVERITIES).toEqual(['none', 'watch', 'approaching', 'exceedance']);
    expect(DEFAULT_THRESHOLDS.watch).toBe(0.75);
  });
});

describe('evaluateRecord', () => {
  it('passes an ordinary record', () => {
    const result = evaluateRecord(record(), cottage);
    expect(result.exceedance).toBe(false);
    expect(result.severity).toBe('none');
    expect(result.ground.limitMmPerSecond).toBe(19.1);
  });

  it('fails a record over the ground limit', () => {
    const loud = record({ transverse: { peakMmPerSecond: 24, frequencyHz: 14 } });
    const result = evaluateRecord(loud, cottage);
    expect(result.exceedance).toBe(true);
    expect(result.channels).toEqual(['ground']);
  });

  it('fails a record over the airblast limit even when the ground is fine', () => {
    const loud = record({ airblastDb: 138 });
    const result = evaluateRecord(loud, { ...cottage, airblastLimitDb: 133 });
    expect(result.exceedance).toBe(true);
    expect(result.channels).toEqual(['airblast']);
    expect(result.groundSeverity).toBe('none');
  });

  it('reports both channels when both go', () => {
    const loud = record({ transverse: { peakMmPerSecond: 30, frequencyHz: 12 }, airblastDb: 140 });
    expect(evaluateRecord(loud, cottage).channels).toEqual(['ground', 'airblast']);
  });

  it('takes a record with no airblast channel', () => {
    const result = evaluateRecord(record({ airblastDb: null }), cottage);
    expect(result.air).toBe(null);
    expect(result.airRatio).toBe(0);
  });

  it('judges against the frequency of the peak component', () => {
    const lowFrequency = record({ transverse: { peakMmPerSecond: 3.1, frequencyHz: 2 } });
    const result = evaluateRecord(lowFrequency, cottage);
    expect(result.ground.limitMmPerSecond).toBeLessThan(19.1);
  });

  it('takes the tighter limit for a listed building', () => {
    const listed = parseReceptor({ ...cottage, id: 'rec_2', structureClass: 'listed' });
    expect(evaluateRecord(record(), listed).ground.limitMmPerSecond).toBeLessThan(19.1);
  });

  it('refuses to judge a record with no receptor', () => {
    expect(() => evaluateRecord(record(), null)).toThrow(ValidationError);
  });
});

describe('evaluateAll', () => {
  const receptors = new Map([['rec_1', cottage]]);

  it('judges every record it can place', () => {
    const { results, unmatched } = evaluateAll([record(), record()], receptors);
    expect(results).toHaveLength(2);
    expect(unmatched).toHaveLength(0);
  });

  it('sets aside a record from a monitor nobody has registered', () => {
    const stray = record({ receptorId: 'rec_missing' });
    const { results, unmatched } = evaluateAll([record(), stray], receptors);
    expect(results).toHaveLength(1);
    expect(unmatched).toHaveLength(1);
  });
});

describe('exceedances and repeats', () => {
  const loud = (at) =>
    evaluateRecord(
      record({ triggeredAt: at, transverse: { peakMmPerSecond: 26, frequencyHz: 14 } }),
      cottage,
    );

  it('picks the breaches out', () => {
    const evaluations = [evaluateRecord(record(), cottage), loud('2025-05-22T13:04:11.000Z')];
    expect(exceedances(evaluations)).toHaveLength(1);
  });

  it('spots two breaches at one receptor inside the window', () => {
    const evaluations = [loud('2025-05-22T13:04:11.000Z'), loud('2025-06-11T13:04:11.000Z')];
    const repeats = repeatExceedances(evaluations);
    expect(repeats).toHaveLength(1);
    expect(repeats[0].receptorId).toBe('rec_1');
  });

  it('does not count two breaches a year apart as a repeat', () => {
    const evaluations = [loud('2025-01-10T13:04:11.000Z'), loud('2025-11-11T13:04:11.000Z')];
    expect(repeatExceedances(evaluations)).toHaveLength(0);
  });

  it('follows a longer window when asked', () => {
    const evaluations = [loud('2025-01-10T13:04:11.000Z'), loud('2025-11-11T13:04:11.000Z')];
    expect(repeatExceedances(evaluations, { withinDays: 400 })).toHaveLength(1);
  });

  it('says nothing about a single breach', () => {
    expect(repeatExceedances([loud('2025-05-22T13:04:11.000Z')])).toHaveLength(0);
  });
});

describe('complianceSummary', () => {
  it('counts the bands and names the worst ratio', () => {
    const evaluations = [
      evaluateRecord(record(), cottage),
      evaluateRecord(record({ transverse: { peakMmPerSecond: 26, frequencyHz: 14 } }), cottage),
    ];
    const summary = complianceSummary(evaluations);
    expect(summary.recordCount).toBe(2);
    expect(summary.exceedanceCount).toBe(1);
    expect(summary.compliant).toBe(false);
    expect(summary.worstRatio).toBeGreaterThan(1);
    expect(summary.channelsBreached).toEqual(['ground']);
  });

  it('reads a clean period as compliant', () => {
    const summary = complianceSummary([evaluateRecord(record(), cottage)]);
    expect(summary.compliant).toBe(true);
    expect(summary.channelsBreached).toEqual([]);
  });

  it('has nothing to say about an empty period', () => {
    expect(complianceSummary([]).worstRatio).toBe(null);
  });
});

describe('highestReading', () => {
  it('finds the loudest event in the set', () => {
    const evaluations = [
      evaluateRecord(record(), cottage),
      evaluateRecord(record({ transverse: { peakMmPerSecond: 9.4, frequencyHz: 14 } }), cottage),
    ];
    expect(highestReading(evaluations).ground.peakMmPerSecond).toBe(9.4);
  });

  it('has no answer for an empty set', () => {
    expect(highestReading([])).toBe(null);
  });
});
