/**
 * The pre-fire clearance.
 *
 * A list of things that have to be true at the moment the shot goes off, each
 * one signed by the person who checked it. Two properties matter and both are
 * enforced here rather than trusted.
 *
 * The first is freshness. A sweep of the quarry done forty minutes ago is not a
 * clearance, because the quarry has had forty minutes to fill up again, so every
 * item carries how long its check stays good for and it goes stale on its own.
 *
 * The second is order. Sentries go out before the roads are stopped, the roads
 * are stopped before the warning signal, and the signal comes before the shot.
 * Doing them in the wrong order can leave a road stopped with nobody watching
 * the far end, so an item whose prerequisites are not done is refused.
 */

import { ValidationError } from '../../lib/errors.js';
import { minutesBetween, isAfter } from '../../lib/clock.js';
import { collector } from '../violations.js';

export const CATEGORIES = ['people', 'plant', 'access', 'sentries', 'signals', 'shot'];

export const STANDARD_CHECKLIST = Object.freeze([
  {
    id: 'plant_withdrawn',
    category: 'plant',
    label: 'plant withdrawn from the zone',
    validForMinutes: 30,
    mandatory: true,
  },
  {
    id: 'people_withdrawn',
    category: 'people',
    label: 'people withdrawn from the zone',
    validForMinutes: 15,
    mandatory: true,
  },
  {
    id: 'zone_swept',
    category: 'people',
    label: 'zone swept and confirmed clear',
    validForMinutes: 15,
    mandatory: true,
    requires: ['plant_withdrawn', 'people_withdrawn'],
  },
  {
    id: 'sentries_posted',
    category: 'sentries',
    label: 'sentries posted on every approach',
    validForMinutes: 30,
    mandatory: true,
    requires: ['zone_swept'],
  },
  {
    id: 'roads_stopped',
    category: 'access',
    label: 'site roads stopped',
    validForMinutes: 15,
    mandatory: true,
    requires: ['sentries_posted'],
  },
  {
    id: 'neighbours_notified',
    category: 'access',
    label: 'neighbours notified',
    validForMinutes: 240,
    mandatory: false,
  },
  {
    id: 'shot_area_clear',
    category: 'shot',
    label: 'shot area clear and tie-in checked',
    validForMinutes: 15,
    mandatory: true,
    requires: ['zone_swept'],
  },
  {
    id: 'warning_signal',
    category: 'signals',
    label: 'warning signal sounded',
    validForMinutes: 5,
    mandatory: true,
    requires: ['roads_stopped', 'shot_area_clear'],
  },
]);

export function startClearance({ blastId, template = STANDARD_CHECKLIST, startedAt, startedBy }) {
  if (!blastId) {
    throw new ValidationError('a clearance belongs to a shot', [
      { path: 'blastId', message: 'no shot given', kind: 'missing' },
    ]);
  }
  return {
    blastId,
    startedAt,
    startedBy,
    items: template.map((item) => ({ ...item, checkedAt: null, checkedBy: null, note: null })),
  };
}

export function itemById(clearance, itemId) {
  const item = clearance.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new ValidationError(`${itemId} is not on this clearance`, [
      { path: 'itemId', message: 'unknown checklist item', kind: 'missing' },
    ]);
  }
  return item;
}

/** Mark an item done. Refuses when something it depends on is not done yet. */
export function check(clearance, itemId, { at, by, note = null }) {
  const item = itemById(clearance, itemId);
  if (!by) {
    throw new ValidationError('a clearance item is signed by somebody', [
      { path: 'by', message: 'no person given', kind: 'missing' },
    ]);
  }
  const outstanding = (item.requires ?? []).filter((requiredId) => {
    const required = itemById(clearance, requiredId);
    return required.checkedAt === null;
  });
  if (outstanding.length > 0) {
    throw new ValidationError(
      `${itemId} cannot be checked before ${outstanding.join(' and ')}`,
      outstanding.map((requiredId) => ({
        path: requiredId,
        message: 'has to be done first',
        kind: 'order',
      })),
    );
  }
  return {
    ...clearance,
    items: clearance.items.map((candidate) =>
      candidate.id === itemId ? { ...candidate, checkedAt: at, checkedBy: by, note } : candidate,
    ),
  };
}

export function uncheck(clearance, itemId, reason) {
  itemById(clearance, itemId);
  const dependants = clearance.items.filter((item) => (item.requires ?? []).includes(itemId));
  const toClear = new Set([itemId, ...dependants.map((item) => item.id)]);
  return {
    ...clearance,
    items: clearance.items.map((item) =>
      toClear.has(item.id)
        ? { ...item, checkedAt: null, checkedBy: null, note: reason ?? item.note }
        : item,
    ),
  };
}

/** Is this item still good at a given moment, or has it gone stale? */
export function isFresh(item, at) {
  if (item.checkedAt === null) {
    return false;
  }
  if (isAfter(item.checkedAt, at)) {
    return false;
  }
  return minutesBetween(item.checkedAt, at) <= item.validForMinutes;
}

/**
 * Can the shot be fired at this moment? Every mandatory item has to be checked
 * and still fresh. Optional items are reported but do not hold the shot.
 */
export function evaluateClearance(clearance, at) {
  const found = collector();
  const stale = [];
  const outstanding = [];
  for (const item of clearance.items) {
    const fresh = isFresh(item, at);
    if (item.checkedAt === null) {
      outstanding.push(item.id);
      if (item.mandatory) {
        found.add('clearance.outstanding', `${item.label} has not been checked`, {
          itemId: item.id,
        });
      }
      continue;
    }
    if (!fresh) {
      stale.push(item.id);
      if (item.mandatory) {
        found.add('clearance.stale', `${item.label} was checked too long ago`, {
          itemId: item.id,
          actual: item.checkedAt,
          required: item.validForMinutes,
        });
      }
    }
  }
  const mandatory = clearance.items.filter((item) => item.mandatory);
  const done = mandatory.filter((item) => item.checkedAt !== null);
  return found.result({
    blastId: clearance.blastId,
    at,
    outstanding,
    stale,
    completeness: mandatory.length === 0 ? 1 : Number((done.length / mandatory.length).toFixed(3)),
    cleared: found.length === 0,
  });
}

/** How long the crew has before the first item goes stale, which is the real clock. */
export function timeRemaining(clearance, at) {
  const checked = clearance.items.filter((item) => item.mandatory && item.checkedAt !== null);
  if (checked.length === 0) {
    return null;
  }
  const remaining = checked.map((item) => ({
    itemId: item.id,
    minutesLeft: Number((item.validForMinutes - minutesBetween(item.checkedAt, at)).toFixed(2)),
  }));
  return remaining.reduce((soonest, candidate) =>
    candidate.minutesLeft < soonest.minutesLeft ? candidate : soonest,
  );
}
