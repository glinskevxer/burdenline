import { describe, it, expect } from 'vitest';
import {
  createClock,
  fixedClock,
  toInstant,
  toZone,
  isInstant,
  addMinutes,
  addDays,
  minutesBetween,
  secondsBetween,
  isBefore,
  isAfter,
  localDate,
  localTime,
  weekdayAt,
  withinLocalWindow,
  timeToMinutes,
  minutesToTime,
  overlaps,
  humanDuration,
} from '../../src/lib/clock.js';
import { AppError } from '../../src/lib/errors.js';

const SITE_ZONE = 'Europe/Dublin';

describe('clocks', () => {
  it('reads the system clock as a UTC instant', () => {
    const clock = createClock();
    expect(isInstant(clock.now())).toBe(true);
  });

  it('holds still when pinned', () => {
    const clock = fixedClock('2025-06-11T09:30:00Z');
    expect(clock.now()).toBe('2025-06-11T09:30:00.000Z');
    expect(clock.now()).toBe('2025-06-11T09:30:00.000Z');
    expect(clock.millis()).toBe(Date.parse('2025-06-11T09:30:00Z'));
  });

  it('reports the calendar date in the zone it is asked for', () => {
    const clock = fixedClock('2025-06-11T23:40:00Z');
    expect(clock.date(UTCZONE)).toBe('2025-06-11');
    expect(clock.date('Pacific/Auckland')).toBe('2025-06-12');
  });

  it('refuses anything that is not a function', () => {
    expect(() => createClock('now')).toThrow(TypeError);
  });
});

const UTCZONE = 'UTC';

describe('parsing', () => {
  it('normalises an offset instant to UTC', () => {
    expect(toInstant('2025-03-04T10:00:00+02:00')).toBe('2025-03-04T08:00:00.000Z');
  });

  it('takes a Date or a millisecond count', () => {
    expect(toInstant(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(toInstant(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('refuses nonsense', () => {
    expect(() => toInstant('yesterday')).toThrow(AppError);
    expect(() => toInstant({})).toThrow(AppError);
    expect(isInstant('yesterday')).toBe(false);
    expect(isInstant(17)).toBe(false);
  });

  it('refuses a zone that does not exist', () => {
    expect(() => toZone('2025-01-01T00:00:00Z', 'Mars/Olympus')).toThrow(AppError);
  });
});

describe('arithmetic', () => {
  const base = '2025-05-20T13:00:00.000Z';

  it('adds minutes and days', () => {
    expect(addMinutes(base, 45)).toBe('2025-05-20T13:45:00.000Z');
    expect(addDays(base, 3)).toBe('2025-05-23T13:00:00.000Z');
  });

  it('measures the gap between two instants', () => {
    expect(minutesBetween(base, addMinutes(base, 90))).toBe(90);
    expect(secondsBetween(base, addMinutes(base, 2))).toBe(120);
  });

  it('orders instants', () => {
    expect(isBefore(base, addMinutes(base, 1))).toBe(true);
    expect(isAfter(base, addMinutes(base, 1))).toBe(false);
  });
});

describe('local views', () => {
  it('reads the date and time at the site', () => {
    const instant = '2025-07-04T22:30:00Z';
    expect(localDate(instant, SITE_ZONE)).toBe('2025-07-04');
    expect(localTime(instant, SITE_ZONE)).toBe('23:30');
    expect(weekdayAt(instant, SITE_ZONE)).toBe('friday');
  });

  it('follows summer time', () => {
    expect(localTime('2025-01-15T12:00:00Z', SITE_ZONE)).toBe('12:00');
    expect(localTime('2025-07-15T12:00:00Z', SITE_ZONE)).toBe('13:00');
  });
});

describe('wall clock windows', () => {
  it('holds a firing window between noon and two', () => {
    expect(withinLocalWindow('2025-07-15T12:30:00Z', SITE_ZONE, '12:00', '14:00')).toBe(true);
    expect(withinLocalWindow('2025-07-15T13:30:00Z', SITE_ZONE, '12:00', '14:00')).toBe(false);
  });

  it('excludes the closing minute', () => {
    expect(withinLocalWindow('2025-01-15T14:00:00Z', SITE_ZONE, '12:00', '14:00')).toBe(false);
  });

  it('reads a window that ends before it starts as running past midnight', () => {
    expect(withinLocalWindow('2025-01-15T23:10:00Z', SITE_ZONE, '22:00', '06:00')).toBe(true);
    expect(withinLocalWindow('2025-01-15T05:00:00Z', SITE_ZONE, '22:00', '06:00')).toBe(true);
    expect(withinLocalWindow('2025-01-15T12:00:00Z', SITE_ZONE, '22:00', '06:00')).toBe(false);
  });

  it('treats an empty window as the whole day', () => {
    expect(withinLocalWindow('2025-01-15T03:00:00Z', SITE_ZONE, '08:00', '08:00')).toBe(true);
  });
});

describe('wall clock parsing', () => {
  it('converts both ways', () => {
    expect(timeToMinutes('13:45')).toBe(825);
    expect(minutesToTime(825)).toBe('13:45');
  });

  it('refuses an hour past the end of the day', () => {
    expect(() => timeToMinutes('24:00')).toThrow(AppError);
    expect(() => timeToMinutes('9:00')).toThrow(AppError);
    expect(() => minutesToTime(1440)).toThrow(AppError);
  });
});

describe('intervals', () => {
  it('spots an overlap between two closures', () => {
    const overlapping = overlaps(
      '2025-02-01T09:00:00Z',
      '2025-02-01T11:00:00Z',
      '2025-02-01T10:30:00Z',
      '2025-02-01T12:00:00Z',
    );
    expect(overlapping).toBe(true);
  });

  it('does not count touching intervals as overlapping', () => {
    const touching = overlaps(
      '2025-02-01T09:00:00Z',
      '2025-02-01T11:00:00Z',
      '2025-02-01T11:00:00Z',
      '2025-02-01T12:00:00Z',
    );
    expect(touching).toBe(false);
  });

  it('refuses a backwards interval', () => {
    expect(() =>
      overlaps(
        '2025-02-01T11:00:00Z',
        '2025-02-01T09:00:00Z',
        '2025-02-01T10:00:00Z',
        '2025-02-01T12:00:00Z',
      ),
    ).toThrow(AppError);
  });
});

describe('humanDuration', () => {
  it('reads a re entry delay in hours and minutes', () => {
    expect(humanDuration(95)).toContain('1');
    expect(humanDuration(95)).toContain('35');
  });
});
