/**
 * The tie-in, and when each hole actually goes off.
 *
 * A shot is tied in on the surface: a trunkline runs to one hole, and from there
 * surface connectors carry the signal hole to hole, each adding its delay. The
 * signal reaches a hole by whatever path gets there first, so the surface
 * arrival time is a shortest path problem and not a sum along one route. The
 * hole then fires its own in-hole delay later.
 *
 * Two things go wrong on real benches and both are caught here. A connector tied
 * back into a hole that has already fired makes a loop, which the crew will not
 * see standing on the bench but which leaves part of the pattern with no
 * consistent time. And a hole nobody connected fires late off a neighbour or not
 * at all, which is a misfire waiting to happen.
 */

import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';

export const networkSchema = z.object({
  initiationHole: z.number().int().positive(),
  trunklineDelayMs: z.number().min(0).max(20000).default(0),
  holes: z
    .array(
      z.object({
        holeNumber: z.number().int().positive(),
        inHoleDelayMs: z.number().min(0).max(20000),
        deckDelaysMs: z.array(z.number().min(0).max(20000)).default([]),
      }),
    )
    .min(1),
  connectors: z
    .array(
      z.object({
        fromHole: z.number().int().positive(),
        toHole: z.number().int().positive(),
        delayMs: z.number().min(0).max(20000),
      }),
    )
    .default([]),
});

export function parseNetwork(input) {
  const parsed = networkSchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the tie-in is not usable');
  }
  const network = parsed.data;
  const numbers = new Set(network.holes.map((hole) => hole.holeNumber));
  if (numbers.size !== network.holes.length) {
    throw new ValidationError('a hole appears twice in the tie-in', [
      { path: 'holes', message: 'duplicate hole number', kind: 'conflict' },
    ]);
  }
  if (!numbers.has(network.initiationHole)) {
    throw new ValidationError('the trunkline goes to a hole that is not in the shot', [
      { path: 'initiationHole', message: 'unknown hole', kind: 'missing' },
    ]);
  }
  for (const connector of network.connectors) {
    for (const end of ['fromHole', 'toHole']) {
      if (!numbers.has(connector[end])) {
        throw new ValidationError(
          `a connector ties to hole ${connector[end]}, which is not in the shot`,
          [{ path: end, message: 'unknown hole', kind: 'missing' }],
        );
      }
    }
    if (connector.fromHole === connector.toHole) {
      throw new ValidationError(`hole ${connector.fromHole} is connected to itself`, [
        { path: 'connectors', message: 'a connector needs two different holes', kind: 'conflict' },
      ]);
    }
  }
  return network;
}

/**
 * Surface arrival time at every hole, by shortest path from the initiation
 * point. Delays are never negative so a plain Dijkstra is correct and there is
 * no need to look for negative cycles.
 */
export function surfaceArrivals(network) {
  const outgoing = new Map();
  for (const connector of network.connectors) {
    const list = outgoing.get(connector.fromHole) ?? [];
    list.push(connector);
    outgoing.set(connector.fromHole, list);
  }
  const arrival = new Map([[network.initiationHole, network.trunklineDelayMs]]);
  const settled = new Set();
  const queue = [network.initiationHole];

  while (queue.length > 0) {
    let bestIndex = 0;
    for (let index = 1; index < queue.length; index += 1) {
      if (arrival.get(queue[index]) < arrival.get(queue[bestIndex])) {
        bestIndex = index;
      }
    }
    const current = queue.splice(bestIndex, 1)[0];
    if (settled.has(current)) {
      continue;
    }
    settled.add(current);
    for (const connector of outgoing.get(current) ?? []) {
      const candidate = roundTo(arrival.get(current) + connector.delayMs, 3);
      if (!arrival.has(connector.toHole) || candidate < arrival.get(connector.toHole)) {
        arrival.set(connector.toHole, candidate);
        queue.push(connector.toHole);
      }
    }
  }
  return arrival;
}

/** Every hole with the time it fires, plus the decks inside it. */
export function resolveFiringTimes(input) {
  const network = parseNetwork(input);
  const arrivals = surfaceArrivals(network);
  const holes = [];
  const unreachable = [];
  for (const hole of network.holes) {
    const arrival = arrivals.get(hole.holeNumber);
    if (arrival === undefined) {
      unreachable.push(hole.holeNumber);
      continue;
    }
    const decks =
      hole.deckDelaysMs.length > 0
        ? hole.deckDelaysMs.map((delay, index) => ({
            deck: index + 1,
            firingTimeMs: roundTo(arrival + delay, 3),
          }))
        : [{ deck: 1, firingTimeMs: roundTo(arrival + hole.inHoleDelayMs, 3) }];
    holes.push({
      holeNumber: hole.holeNumber,
      surfaceArrivalMs: arrival,
      inHoleDelayMs: hole.inHoleDelayMs,
      firingTimeMs: decks[0].firingTimeMs,
      decks,
    });
  }
  holes.sort((a, b) => a.firingTimeMs - b.firingTimeMs || a.holeNumber - b.holeNumber);
  return {
    holes,
    unreachable,
    loops: findLoops(network),
    firstFiringMs: holes.length ? holes[0].firingTimeMs : null,
    lastFiringMs: holes.length ? holes.at(-1).firingTimeMs : null,
    durationMs: holes.length ? roundTo(holes.at(-1).firingTimeMs - holes[0].firingTimeMs, 3) : null,
  };
}

/** Any cycle in the surface tie-in, reported as the holes that make it up. */
export function findLoops(network) {
  const outgoing = new Map();
  for (const connector of network.connectors) {
    const list = outgoing.get(connector.fromHole) ?? [];
    list.push(connector.toHole);
    outgoing.set(connector.fromHole, list);
  }
  const colour = new Map();
  const loops = [];
  const stack = [];

  const walk = (hole) => {
    colour.set(hole, 'grey');
    stack.push(hole);
    for (const next of outgoing.get(hole) ?? []) {
      if (colour.get(next) === 'grey') {
        const start = stack.indexOf(next);
        loops.push(stack.slice(start).concat(next));
      } else if (!colour.has(next)) {
        walk(next);
      }
    }
    stack.pop();
    colour.set(hole, 'black');
  };

  for (const hole of network.holes) {
    if (!colour.has(hole.holeNumber)) {
      walk(hole.holeNumber);
    }
  }
  return loops;
}

/** Holes that fire within a given gap of each other, which is what MIC groups on. */
export function firingOrder(resolved) {
  return resolved.holes.map((hole, index) => ({
    position: index + 1,
    holeNumber: hole.holeNumber,
    firingTimeMs: hole.firingTimeMs,
    gapFromPreviousMs:
      index === 0 ? null : roundTo(hole.firingTimeMs - resolved.holes[index - 1].firingTimeMs, 3),
  }));
}
