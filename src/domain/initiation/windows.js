/**
 * The maximum instantaneous charge.
 *
 * Ground vibration does not care how much explosive is in the shot. It cares how
 * much goes off close enough together to arrive as one pulse, and the convention
 * every regulator here works to is an eight millisecond window. So the number
 * that matters is the largest total charge inside any eight millisecond span,
 * which is a sliding window over the firing times and not a grouping into fixed
 * buckets. Buckets are the mistake worth naming: two holes eight milliseconds
 * apart can land in different buckets and still arrive together.
 */

import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';

export const DEFAULT_WINDOW_MS = 8;

/**
 * Charges that go off inside one window, with the total. Each entry is one deck,
 * because a decked hole with a separator between the charges is two separate
 * pulses and counting it as one overstates the charge badly.
 */
export function chargeEvents(resolved, massByHole) {
  const events = [];
  for (const hole of resolved.holes) {
    const holeMass = massByHole.get(hole.holeNumber);
    if (holeMass === undefined) {
      throw new ValidationError(`no charge mass for hole ${hole.holeNumber}`, [
        { path: 'massByHole', message: 'the load sheet and the tie-in disagree', kind: 'missing' },
      ]);
    }
    const decks = hole.decks ?? [{ deck: 1, firingTimeMs: hole.firingTimeMs }];
    const perDeck = Array.isArray(holeMass) ? holeMass : decks.map(() => holeMass / decks.length);
    if (perDeck.length !== decks.length) {
      throw new ValidationError(
        `hole ${hole.holeNumber} has ${decks.length} decks and ${perDeck.length} masses`,
        [{ path: 'massByHole', message: 'deck count does not match', kind: 'conflict' }],
      );
    }
    decks.forEach((deck, index) => {
      events.push({
        holeNumber: hole.holeNumber,
        deck: deck.deck,
        firingTimeMs: deck.firingTimeMs,
        massKg: roundTo(perDeck[index], 3),
      });
    });
  }
  return events.sort((a, b) => a.firingTimeMs - b.firingTimeMs || a.holeNumber - b.holeNumber);
}

/**
 * The heaviest window in the shot. The window is half open: a charge exactly
 * `windowMs` after another is treated as a separate pulse, which is the reading
 * the guidance takes.
 */
export function maximumInstantaneousCharge(events, windowMs = DEFAULT_WINDOW_MS) {
  if (!(windowMs > 0)) {
    throw new ValidationError('the window has to be positive', [
      { path: 'windowMs', message: 'must be greater than zero', kind: 'range' },
    ]);
  }
  if (events.length === 0) {
    return { massKg: 0, startMs: null, endMs: null, events: [] };
  }
  const sorted = [...events].sort((a, b) => a.firingTimeMs - b.firingTimeMs);
  let best = { massKg: -1, startMs: null, endMs: null, events: [] };
  let head = 0;
  let running = 0;
  for (let tail = 0; tail < sorted.length; tail += 1) {
    running += sorted[tail].massKg;
    while (sorted[tail].firingTimeMs - sorted[head].firingTimeMs >= windowMs) {
      running -= sorted[head].massKg;
      head += 1;
    }
    const massKg = roundTo(running, 3);
    if (massKg > best.massKg) {
      best = {
        massKg,
        startMs: sorted[head].firingTimeMs,
        endMs: sorted[tail].firingTimeMs,
        events: sorted.slice(head, tail + 1),
      };
    }
  }
  return best;
}

/** Every window in the shot that carries charge, for the timing report. */
export function windowProfile(events, windowMs = DEFAULT_WINDOW_MS) {
  const sorted = [...events].sort((a, b) => a.firingTimeMs - b.firingTimeMs);
  const windows = [];
  let index = 0;
  while (index < sorted.length) {
    const startMs = sorted[index].firingTimeMs;
    const group = [];
    while (index < sorted.length && sorted[index].firingTimeMs - startMs < windowMs) {
      group.push(sorted[index]);
      index += 1;
    }
    windows.push({
      startMs,
      endMs: group.at(-1).firingTimeMs,
      massKg: roundTo(
        group.reduce((sum, event) => sum + event.massKg, 0),
        3,
      ),
      holeCount: new Set(group.map((event) => event.holeNumber)).size,
      deckCount: group.length,
    });
  }
  return windows;
}

/** Total charge in the shot, which the licence and the day-book both want. */
export function totalCharge(events) {
  return roundTo(
    events.reduce((sum, event) => sum + event.massKg, 0),
    3,
  );
}

export function summariseTiming(resolved, massByHole, windowMs = DEFAULT_WINDOW_MS) {
  const events = chargeEvents(resolved, massByHole);
  const heaviest = maximumInstantaneousCharge(events, windowMs);
  const profile = windowProfile(events, windowMs);
  return {
    windowMs,
    events,
    totalMassKg: totalCharge(events),
    maximumInstantaneousChargeKg: heaviest.massKg,
    heaviestWindow: heaviest,
    windowCount: profile.length,
    holesInHeaviestWindow: new Set(heaviest.events.map((event) => event.holeNumber)).size,
    durationMs: resolved.durationMs,
  };
}
