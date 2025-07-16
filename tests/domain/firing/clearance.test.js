import { describe, it, expect } from 'vitest';
import {
  STANDARD_CHECKLIST,
  CATEGORIES,
  startClearance,
  itemById,
  check,
  uncheck,
  isFresh,
  evaluateClearance,
  timeRemaining,
} from '../../../src/domain/firing/clearance.js';
import { ValidationError } from '../../../src/lib/errors.js';

const startedAt = '2025-07-08T12:00:00.000Z';

function fresh() {
  return startClearance({ blastId: 'blast_1', startedAt, startedBy: 'per_1' });
}

/** Walk the whole list in order, each item a minute after the last. */
function fullyChecked(from = startedAt) {
  const order = [
    'plant_withdrawn',
    'people_withdrawn',
    'zone_swept',
    'sentries_posted',
    'roads_stopped',
    'neighbours_notified',
    'shot_area_clear',
    'warning_signal',
  ];
  return order.reduce(
    (clearance, itemId, index) =>
      check(clearance, itemId, {
        at: new Date(Date.parse(from) + index * 60000).toISOString(),
        by: 'per_1',
      }),
    fresh(),
  );
}

describe('the standard checklist', () => {
  it('covers every category', () => {
    const used = new Set(STANDARD_CHECKLIST.map((item) => item.category));
    for (const category of CATEGORIES) {
      expect(used.has(category)).toBe(true);
    }
  });

  it('gives the warning signal the shortest life of all', () => {
    const signal = STANDARD_CHECKLIST.find((item) => item.id === 'warning_signal');
    const shortest = Math.min(...STANDARD_CHECKLIST.map((item) => item.validForMinutes));
    expect(signal.validForMinutes).toBe(shortest);
  });

  it('points every prerequisite at an item that exists', () => {
    const ids = new Set(STANDARD_CHECKLIST.map((item) => item.id));
    for (const item of STANDARD_CHECKLIST) {
      for (const required of item.requires ?? []) {
        expect(ids.has(required)).toBe(true);
      }
    }
  });
});

describe('startClearance', () => {
  it('copies the template with nothing checked', () => {
    const clearance = fresh();
    expect(clearance.items).toHaveLength(STANDARD_CHECKLIST.length);
    expect(clearance.items.every((item) => item.checkedAt === null)).toBe(true);
  });

  it('refuses a clearance with no shot', () => {
    expect(() => startClearance({ startedAt, startedBy: 'per_1' })).toThrow(ValidationError);
  });

  it('refuses to find an item that is not on it', () => {
    expect(() => itemById(fresh(), 'coffee')).toThrow(/not on this clearance/);
  });
});

describe('check', () => {
  it('marks an item done with who and when', () => {
    const clearance = check(fresh(), 'plant_withdrawn', { at: startedAt, by: 'per_2' });
    expect(itemById(clearance, 'plant_withdrawn')).toMatchObject({
      checkedAt: startedAt,
      checkedBy: 'per_2',
    });
  });

  it('refuses an item whose prerequisites are not done', () => {
    expect(() => check(fresh(), 'sentries_posted', { at: startedAt, by: 'per_2' })).toThrow(
      /cannot be checked before/,
    );
  });

  it('names every prerequisite that is outstanding', () => {
    try {
      check(fresh(), 'zone_swept', { at: startedAt, by: 'per_2' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.issues.map((issue) => issue.path).sort()).toEqual([
        'people_withdrawn',
        'plant_withdrawn',
      ]);
    }
  });

  it('refuses an item nobody signed', () => {
    expect(() => check(fresh(), 'plant_withdrawn', { at: startedAt })).toThrow(
      /signed by somebody/,
    );
  });

  it('leaves the original clearance alone', () => {
    const before = fresh();
    check(before, 'plant_withdrawn', { at: startedAt, by: 'per_2' });
    expect(itemById(before, 'plant_withdrawn').checkedAt).toBe(null);
  });
});

describe('uncheck', () => {
  it('clears an item and everything that depended on it', () => {
    const cleared = uncheck(fullyChecked(), 'zone_swept', 'a loader came back in');
    expect(itemById(cleared, 'zone_swept').checkedAt).toBe(null);
    expect(itemById(cleared, 'sentries_posted').checkedAt).toBe(null);
    expect(itemById(cleared, 'shot_area_clear').checkedAt).toBe(null);
  });

  it('leaves unrelated items alone', () => {
    const cleared = uncheck(fullyChecked(), 'zone_swept', 'a loader came back in');
    expect(itemById(cleared, 'plant_withdrawn').checkedAt).not.toBe(null);
  });

  it('records why it was cleared', () => {
    const cleared = uncheck(fullyChecked(), 'zone_swept', 'a loader came back in');
    expect(itemById(cleared, 'zone_swept').note).toContain('loader');
  });
});

describe('isFresh', () => {
  const item = { checkedAt: '2025-07-08T12:00:00.000Z', validForMinutes: 15 };

  it('holds inside the window', () => {
    expect(isFresh(item, '2025-07-08T12:10:00.000Z')).toBe(true);
  });

  it('goes stale past it', () => {
    expect(isFresh(item, '2025-07-08T12:20:00.000Z')).toBe(false);
  });

  it('is never fresh before it was checked', () => {
    expect(isFresh(item, '2025-07-08T11:50:00.000Z')).toBe(false);
  });

  it('is never fresh when it was never checked', () => {
    expect(isFresh({ checkedAt: null, validForMinutes: 15 }, '2025-07-08T12:00:00.000Z')).toBe(
      false,
    );
  });
});

describe('evaluateClearance', () => {
  it('clears a shot with everything freshly checked', () => {
    const result = evaluateClearance(fullyChecked(), '2025-07-08T12:09:00.000Z');
    expect(result.cleared).toBe(true);
    expect(result.completeness).toBe(1);
  });

  it('holds a shot with a mandatory item outstanding', () => {
    const partial = check(fresh(), 'plant_withdrawn', { at: startedAt, by: 'per_1' });
    const result = evaluateClearance(partial, startedAt);
    expect(result.cleared).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain('clearance.outstanding');
  });

  it('holds a shot whose sweep has gone stale', () => {
    const result = evaluateClearance(fullyChecked(), '2025-07-08T12:40:00.000Z');
    expect(result.cleared).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain('clearance.stale');
    expect(result.stale).toContain('warning_signal');
  });

  it('does not hold a shot on an optional item', () => {
    const order = [
      'plant_withdrawn',
      'people_withdrawn',
      'zone_swept',
      'sentries_posted',
      'roads_stopped',
      'shot_area_clear',
      'warning_signal',
    ];
    const withoutNeighbours = order.reduce(
      (clearance, itemId, index) =>
        check(clearance, itemId, {
          at: new Date(Date.parse(startedAt) + index * 60000).toISOString(),
          by: 'per_1',
        }),
      fresh(),
    );
    const result = evaluateClearance(withoutNeighbours, '2025-07-08T12:08:00.000Z');
    expect(result.cleared).toBe(true);
    expect(result.outstanding).toEqual(['neighbours_notified']);
  });

  it('reports how far through the list the crew is', () => {
    const partial = check(fresh(), 'plant_withdrawn', { at: startedAt, by: 'per_1' });
    expect(evaluateClearance(partial, startedAt).completeness).toBeCloseTo(0.143, 3);
  });
});

describe('timeRemaining', () => {
  it('names the item that goes stale first', () => {
    const remaining = timeRemaining(fullyChecked(), '2025-07-08T12:08:00.000Z');
    expect(remaining.itemId).toBe('warning_signal');
    expect(remaining.minutesLeft).toBeCloseTo(4, 2);
  });

  it('goes negative once something has already gone stale', () => {
    expect(timeRemaining(fullyChecked(), '2025-07-08T12:30:00.000Z').minutesLeft).toBeLessThan(0);
  });

  it('has nothing to say before anything is checked', () => {
    expect(timeRemaining(fresh(), startedAt)).toBe(null);
  });
});
