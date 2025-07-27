/**
 * When a shot is allowed to go off.
 *
 * The planning permission gives hours, usually something like weekday afternoons
 * with nothing at the weekend, and the site adds its own embargoes on top: the
 * week of the state exams because the school is four hundred metres away, the
 * mornings the water treatment works runs its own tests, the day of a funeral at
 * the church. Both kinds are held the same way and an embargo always wins over a
 * permitted window.
 *
 * Neighbours also get notice, and notice has a shape: told at least so long
 * before, and not so long before that everybody has forgotten.
 */

import { ValidationError } from '../../lib/errors.js';
import {
  localDate,
  localTime,
  weekdayAt,
  timeToMinutes,
  withinLocalWindow,
  minutesBetween,
} from '../../lib/clock.js';
import { collector } from '../violations.js';

export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export const DEFAULT_NOTICE_RULES = Object.freeze({
  minimumNoticeHours: 24,
  maximumNoticeHours: 168,
});

export function parseSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') {
    throw new ValidationError('a firing schedule is needed', [
      { path: 'schedule', message: 'no schedule given', kind: 'missing' },
    ]);
  }
  const windows = {};
  for (const [day, ranges] of Object.entries(schedule)) {
    if (!WEEKDAYS.includes(day)) {
      throw new ValidationError(`${day} is not a day of the week`, [
        { path: 'schedule', message: `expected one of ${WEEKDAYS.join(', ')}`, kind: 'enum' },
      ]);
    }
    windows[day] = (ranges ?? []).map((range) => {
      const from = timeToMinutes(range.from);
      const to = timeToMinutes(range.to);
      if (to <= from) {
        throw new ValidationError(`a firing window on ${day} ends before it starts`, [
          { path: 'schedule', message: `${range.from} to ${range.to}`, kind: 'range' },
        ]);
      }
      return { from: range.from, to: range.to };
    });
  }
  return windows;
}

export function permittedOn(schedule, instant, zone) {
  const day = weekdayAt(instant, zone);
  return schedule[day] ?? [];
}

export function withinPermittedWindow(schedule, instant, zone) {
  return permittedOn(schedule, instant, zone).some((range) =>
    withinLocalWindow(instant, zone, range.from, range.to),
  );
}

/** An embargo is a date or a date and a window, and it always beats the schedule. */
export function embargoesOn(embargoes, instant, zone) {
  const date = localDate(instant, zone);
  return embargoes.filter((embargo) => {
    if (embargo.from && embargo.to) {
      return date >= embargo.from && date <= embargo.to;
    }
    if (embargo.date !== date) {
      return false;
    }
    if (!embargo.fromTime || !embargo.toTime) {
      return true;
    }
    return withinLocalWindow(instant, zone, embargo.fromTime, embargo.toTime);
  });
}

/**
 * The whole timing question for one proposed moment: inside a permitted window,
 * not under an embargo, and with notice given properly.
 */
export function checkFiringTime({
  instant,
  zone,
  schedule,
  embargoes = [],
  notice = null,
  rules = DEFAULT_NOTICE_RULES,
}) {
  const found = collector();
  const windows = permittedOn(schedule, instant, zone);

  if (windows.length === 0) {
    found.add('firing.day_not_permitted', `no shot is permitted on a ${weekdayAt(instant, zone)}`, {
      day: weekdayAt(instant, zone),
    });
  } else if (!withinPermittedWindow(schedule, instant, zone)) {
    found.add(
      'firing.outside_window',
      `${localTime(instant, zone)} is outside the permitted ${windows.map((w) => `${w.from} to ${w.to}`).join(' and ')}`,
      { at: localTime(instant, zone) },
    );
  }

  for (const embargo of embargoesOn(embargoes, instant, zone)) {
    found.add('firing.embargo', embargo.reason ?? 'an embargo covers this time', {
      embargoId: embargo.id ?? null,
    });
  }

  if (notice) {
    const hours = minutesBetween(notice.givenAt, instant) / 60;
    if (hours < rules.minimumNoticeHours) {
      found.add('firing.notice_short', `only ${hours.toFixed(1)} hours of notice was given`, {
        actual: Number(hours.toFixed(2)),
        required: rules.minimumNoticeHours,
      });
    }
    if (hours > rules.maximumNoticeHours) {
      found.add('firing.notice_stale', `the notice was given ${(hours / 24).toFixed(1)} days ago`, {
        actual: Number(hours.toFixed(2)),
        required: rules.maximumNoticeHours,
      });
    }
  }

  return found.result({
    instant,
    localTime: localTime(instant, zone),
    day: weekdayAt(instant, zone),
    windows,
    permitted: found.length === 0,
  });
}

/** The next moment a shot could legally go off, searched a minute at a time. */
export function nextPermitted({ from, zone, schedule, embargoes = [], limitDays = 14 }) {
  const step = 15 * 60 * 1000;
  const limit = Date.parse(from) + limitDays * 24 * 60 * 60 * 1000;
  for (let time = Date.parse(from); time <= limit; time += step) {
    const instant = new Date(time).toISOString();
    const result = checkFiringTime({ instant, zone, schedule, embargoes });
    if (result.permitted) {
      return instant;
    }
  }
  return null;
}
