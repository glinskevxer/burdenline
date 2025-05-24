import { describe, it, expect } from 'vitest';
import {
  parseRecord,
  isTriggered,
  usableForFit,
  matchToBlast,
  summariseRecords,
  COMPONENTS,
} from '../../../src/domain/monitoring/records.js';
import { ValidationError } from '../../../src/lib/errors.js';

const base = {
  monitorSerial: 'BE-11482',
  receptorId: 'rec_1',
  triggeredAt: '2025-05-22T13:04:11.000Z',
  distanceM: 412,
  longitudinal: { peakMmPerSecond: 2.4, frequencyHz: 18 },
  transverse: { peakMmPerSecond: 3.1, frequencyHz: 14 },
  vertical: { peakMmPerSecond: 1.9, frequencyHz: 26 },
  airblastDb: 112.4,
  triggerLevelMmPerSecond: 0.5,
};

describe('parseRecord', () => {
  it('takes a well formed record', () => {
    const record = parseRecord(base);
    expect(record.monitorSerial).toBe('BE-11482');
    expect(Object.isFrozen(record)).toBe(true);
  });

  it('reports the largest component as the peak, not the vector sum', () => {
    const record = parseRecord(base);
    expect(record.peakMmPerSecond).toBe(3.1);
    expect(record.peakComponent).toBe('transverse');
    expect(record.vectorSumMmPerSecond).toBeGreaterThan(record.peakMmPerSecond);
  });

  it('carries the frequency of the peak component, not of the others', () => {
    expect(parseRecord(base).peakFrequencyHz).toBe(14);
  });

  it('computes the vector sum for the agreements written on it', () => {
    expect(parseRecord(base).vectorSumMmPerSecond).toBeCloseTo(4.3566, 3);
  });

  it('takes a record with no frequency reported', () => {
    const record = parseRecord({
      ...base,
      transverse: { peakMmPerSecond: 3.1 },
    });
    expect(record.peakFrequencyHz).toBe(null);
  });

  it('refuses a trigger time that is not one', () => {
    expect(() => parseRecord({ ...base, triggeredAt: 'yesterday' })).toThrow(ValidationError);
  });

  it('refuses a reading no monitor could produce', () => {
    expect(() =>
      parseRecord({ ...base, vertical: { peakMmPerSecond: -1, frequencyHz: 10 } }),
    ).toThrow(ValidationError);
    expect(() => parseRecord({ ...base, airblastDb: 40 })).toThrow(ValidationError);
  });

  it('names the three components', () => {
    expect(COMPONENTS).toEqual(['longitudinal', 'transverse', 'vertical']);
  });
});

describe('isTriggered', () => {
  it('reads a record above the trigger as real', () => {
    expect(isTriggered(parseRecord(base))).toBe(true);
  });

  it('reads a record below the trigger as nothing happening', () => {
    const quiet = parseRecord({
      ...base,
      longitudinal: { peakMmPerSecond: 0.2, frequencyHz: 12 },
      transverse: { peakMmPerSecond: 0.1, frequencyHz: 12 },
      vertical: { peakMmPerSecond: 0.15, frequencyHz: 12 },
    });
    expect(isTriggered(quiet)).toBe(false);
  });

  it('falls back to any motion at all when no trigger level is recorded', () => {
    const record = parseRecord({ ...base, triggerLevelMmPerSecond: null });
    expect(isTriggered(record)).toBe(true);
  });
});

describe('usableForFit', () => {
  it('keeps a full record', () => {
    expect(usableForFit([parseRecord(base)])).toHaveLength(1);
  });

  it('drops a record with no distance', () => {
    expect(usableForFit([parseRecord({ ...base, distanceM: null })])).toHaveLength(0);
  });

  it('drops an untriggered record', () => {
    const quiet = parseRecord({
      ...base,
      longitudinal: { peakMmPerSecond: 0.1 },
      transverse: { peakMmPerSecond: 0.1 },
      vertical: { peakMmPerSecond: 0.1 },
    });
    expect(usableForFit([quiet])).toHaveLength(0);
  });
});

describe('matchToBlast', () => {
  const blasts = [
    { id: 'blast_1', firedAt: '2025-05-22T13:04:09.000Z' },
    { id: 'blast_2', firedAt: '2025-05-22T15:41:00.000Z' },
  ];

  it('matches a record to the shot it heard', () => {
    const match = matchToBlast(parseRecord(base), blasts);
    expect(match.matched).toBe(true);
    expect(match.blast.id).toBe('blast_1');
    expect(match.gapSeconds).toBe(2);
  });

  it('leaves a record from an unrelated day unmatched', () => {
    const stray = parseRecord({ ...base, triggeredAt: '2025-05-25T09:00:00.000Z' });
    expect(matchToBlast(stray, blasts).matched).toBe(false);
  });

  it('says when two shots are close enough to be confused', () => {
    const close = [...blasts, { id: 'blast_3', firedAt: '2025-05-22T13:05:00.000Z' }];
    const match = matchToBlast(parseRecord(base), close);
    expect(match.ambiguous).toBe(true);
    expect(match.blast.id).toBe('blast_1');
  });

  it('follows the tolerance it is given', () => {
    const late = parseRecord({ ...base, triggeredAt: '2025-05-22T13:10:00.000Z' });
    expect(matchToBlast(late, blasts).matched).toBe(false);
    expect(matchToBlast(late, blasts, 600).matched).toBe(true);
  });
});

describe('summariseRecords', () => {
  it('reports the highest record and the average', () => {
    const records = [
      parseRecord(base),
      parseRecord({
        ...base,
        monitorSerial: 'BE-2',
        transverse: { peakMmPerSecond: 6.2, frequencyHz: 9 },
      }),
    ];
    const summary = summariseRecords(records);
    expect(summary.count).toBe(2);
    expect(summary.highest.peakMmPerSecond).toBe(6.2);
    expect(summary.meanPeak).toBeCloseTo(4.65, 2);
  });

  it('reports the loudest airblast', () => {
    const records = [parseRecord(base), parseRecord({ ...base, airblastDb: 121 })];
    expect(summariseRecords(records).highestAirblastDb).toBe(121);
  });

  it('says nothing happened when nothing triggered', () => {
    const quiet = parseRecord({
      ...base,
      longitudinal: { peakMmPerSecond: 0.1 },
      transverse: { peakMmPerSecond: 0.1 },
      vertical: { peakMmPerSecond: 0.1 },
    });
    expect(summariseRecords([quiet])).toMatchObject({ triggeredCount: 0, highest: null });
  });
});
