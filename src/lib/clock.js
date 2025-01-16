/**
 * Time handling.
 *
 * Instants are stored as ISO 8601 strings in UTC. Everything a person reads is
 * in the site zone, because a firing window of noon to two in the afternoon means
 * local noon at the quarry and nothing else. Nothing in the codebase calls
 * `Date.now` directly except the default clock built here, so tests can hold time
 * still without stubbing globals.
 */

import { DateTime, Duration, Interval } from 'luxon';
import { AppError } from './errors.js';

export const UTC = 'UTC';

export function createClock(source = () => new Date()) {
  if (typeof source !== 'function') {
    throw new TypeError('a clock needs a function that returns a Date');
  }
  return {
    now() {
      return toInstant(source());
    },
    date(zone = UTC) {
      return toZone(this.now(), zone).toISODate();
    },
    millis() {
      return DateTime.fromISO(this.now()).toMillis();
    },
  };
}

/** A clock pinned to one instant, for tests and for replaying a day. */
export function fixedClock(instant) {
  const pinned = toInstant(instant);
  return createClock(() => new Date(pinned));
}

export function toInstant(value) {
  const parsed = parse(value);
  return parsed.toUTC().toISO({ suppressMilliseconds: false });
}

export function toZone(value, zone) {
  const parsed = parse(value).setZone(zone);
  if (!parsed.isValid) {
    throw new AppError(`${zone} is not a time zone`, { code: 'bad_zone', status: 400 });
  }
  return parsed;
}

export function isInstant(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return DateTime.fromISO(value, { zone: UTC }).isValid;
}

export function addMinutes(instant, minutes) {
  return toInstant(parse(instant).plus({ minutes }));
}

export function addDays(instant, days) {
  return toInstant(parse(instant).plus({ days }));
}

export function minutesBetween(from, to) {
  return parse(to).diff(parse(from), 'minutes').minutes;
}

export function secondsBetween(from, to) {
  return parse(to).diff(parse(from), 'seconds').seconds;
}

export function isBefore(a, b) {
  return parse(a) < parse(b);
}

export function isAfter(a, b) {
  return parse(a) > parse(b);
}

/** The local calendar date at the site, which is what a day-book page is keyed on. */
export function localDate(instant, zone) {
  return toZone(instant, zone).toISODate();
}

export function localTime(instant, zone) {
  return toZone(instant, zone).toFormat('HH:mm');
}

export function weekdayAt(instant, zone) {
  return toZone(instant, zone).weekdayLong.toLowerCase();
}

/**
 * Does a local wall clock time fall inside a window written as HH:mm strings?
 * A window that ends before it starts is read as running past midnight, which is
 * how the night embargo on secondary breaking is written down.
 */
export function withinLocalWindow(instant, zone, from, to) {
  const minutes = timeToMinutes(localTime(instant, zone));
  const start = timeToMinutes(from);
  const end = timeToMinutes(to);
  if (start === end) {
    return true;
  }
  if (start < end) {
    return minutes >= start && minutes < end;
  }
  return minutes >= start || minutes < end;
}

export function timeToMinutes(text) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text));
  if (!match) {
    throw new AppError(`${text} is not a wall clock time`, { code: 'bad_time', status: 400 });
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesToTime(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) {
    throw new AppError('minutes past midnight run from 0 to 1439', {
      code: 'bad_time',
      status: 400,
    });
  }
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function overlaps(startA, endA, startB, endB) {
  const first = Interval.fromDateTimes(parse(startA), parse(endA));
  const second = Interval.fromDateTimes(parse(startB), parse(endB));
  if (!first.isValid || !second.isValid) {
    throw new AppError('an interval has to end after it starts', {
      code: 'bad_interval',
      status: 400,
    });
  }
  return first.overlaps(second);
}

export function humanDuration(minutes) {
  return Duration.fromObject({ minutes }).shiftTo('hours', 'minutes').toHuman({
    unitDisplay: 'short',
  });
}

function parse(value) {
  if (value instanceof Date) {
    return DateTime.fromJSDate(value, { zone: UTC });
  }
  if (value instanceof DateTime) {
    return value;
  }
  if (typeof value === 'number') {
    return DateTime.fromMillis(value, { zone: UTC });
  }
  if (typeof value === 'string') {
    const parsed = DateTime.fromISO(value, { zone: UTC, setZone: true });
    if (!parsed.isValid) {
      throw new AppError(`${value} is not an instant`, { code: 'bad_instant', status: 400 });
    }
    return parsed;
  }
  throw new AppError('an instant is a string, a number or a Date', {
    code: 'bad_instant',
    status: 400,
  });
}
