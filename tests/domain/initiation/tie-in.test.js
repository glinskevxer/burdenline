import { describe, it, expect } from 'vitest';
import {
  parseNetwork,
  surfaceArrivals,
  resolveFiringTimes,
  findLoops,
  firingOrder,
} from '../../../src/domain/initiation/tie-in.js';
import { ValidationError } from '../../../src/lib/errors.js';

/** A straight row of five holes, tied hole to hole with 25 ms connectors. */
function row(holeCount = 5, delayMs = 25, inHoleDelayMs = 500) {
  return {
    initiationHole: 1,
    holes: Array.from({ length: holeCount }, (_unused, index) => ({
      holeNumber: index + 1,
      inHoleDelayMs,
    })),
    connectors: Array.from({ length: holeCount - 1 }, (_unused, index) => ({
      fromHole: index + 1,
      toHole: index + 2,
      delayMs,
    })),
  };
}

describe('parseNetwork', () => {
  it('takes a tied row', () => {
    expect(parseNetwork(row()).holes).toHaveLength(5);
  });

  it('refuses a shot with no holes', () => {
    expect(() => parseNetwork({ ...row(), holes: [] })).toThrow(ValidationError);
  });

  it('refuses the same hole twice', () => {
    const network = row(2);
    network.holes.push({ holeNumber: 1, inHoleDelayMs: 500 });
    expect(() => parseNetwork(network)).toThrow(/appears twice/);
  });

  it('refuses a trunkline to a hole that is not in the shot', () => {
    expect(() => parseNetwork({ ...row(), initiationHole: 9 })).toThrow(/not in the shot/);
  });

  it('refuses a connector to a hole that is not in the shot', () => {
    const network = row(3);
    network.connectors.push({ fromHole: 3, toHole: 44, delayMs: 25 });
    expect(() => parseNetwork(network)).toThrow(/hole 44/);
  });

  it('refuses a hole tied to itself', () => {
    const network = row(3);
    network.connectors.push({ fromHole: 2, toHole: 2, delayMs: 25 });
    expect(() => parseNetwork(network)).toThrow(/connected to itself/);
  });
});

describe('surfaceArrivals', () => {
  it('starts at the trunkline delay', () => {
    const arrivals = surfaceArrivals(parseNetwork({ ...row(), trunklineDelayMs: 200 }));
    expect(arrivals.get(1)).toBe(200);
    expect(arrivals.get(2)).toBe(225);
  });

  it('adds a connector at each step down the row', () => {
    const arrivals = surfaceArrivals(parseNetwork(row()));
    expect([...arrivals.entries()].sort()).toEqual([
      [1, 0],
      [2, 25],
      [3, 50],
      [4, 75],
      [5, 100],
    ]);
  });

  it('takes the path that gets there first when a hole is tied two ways', () => {
    const network = parseNetwork({
      initiationHole: 1,
      holes: [1, 2, 3, 4].map((holeNumber) => ({ holeNumber, inHoleDelayMs: 500 })),
      connectors: [
        { fromHole: 1, toHole: 2, delayMs: 25 },
        { fromHole: 2, toHole: 4, delayMs: 100 },
        { fromHole: 1, toHole: 3, delayMs: 17 },
        { fromHole: 3, toHole: 4, delayMs: 17 },
      ],
    });
    expect(surfaceArrivals(network).get(4)).toBe(34);
  });

  it('leaves a hole nobody tied out of the map', () => {
    const network = parseNetwork({
      initiationHole: 1,
      holes: [1, 2, 9].map((holeNumber) => ({ holeNumber, inHoleDelayMs: 500 })),
      connectors: [{ fromHole: 1, toHole: 2, delayMs: 25 }],
    });
    expect(surfaceArrivals(network).has(9)).toBe(false);
  });
});

describe('resolveFiringTimes', () => {
  it('fires each hole its in hole delay after the signal arrives', () => {
    const resolved = resolveFiringTimes(row());
    expect(resolved.holes[0]).toMatchObject({ holeNumber: 1, firingTimeMs: 500 });
    expect(resolved.holes[4]).toMatchObject({ holeNumber: 5, firingTimeMs: 600 });
  });

  it('sorts the holes into the order they go off', () => {
    const resolved = resolveFiringTimes(row());
    expect(resolved.holes.map((hole) => hole.holeNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it('reports how long the shot runs for', () => {
    const resolved = resolveFiringTimes(row());
    expect(resolved.firstFiringMs).toBe(500);
    expect(resolved.lastFiringMs).toBe(600);
    expect(resolved.durationMs).toBe(100);
  });

  it('reports a hole nobody connected rather than guessing a time', () => {
    const network = row(3);
    network.holes.push({ holeNumber: 8, inHoleDelayMs: 500 });
    const resolved = resolveFiringTimes(network);
    expect(resolved.unreachable).toEqual([8]);
    expect(resolved.holes).toHaveLength(3);
  });

  it('gives a decked hole one time per deck', () => {
    const network = row(2);
    network.holes[0] = { holeNumber: 1, inHoleDelayMs: 500, deckDelaysMs: [500, 525] };
    const resolved = resolveFiringTimes(network);
    const decked = resolved.holes.find((hole) => hole.holeNumber === 1);
    expect(decked.decks).toEqual([
      { deck: 1, firingTimeMs: 500 },
      { deck: 2, firingTimeMs: 525 },
    ]);
  });

  it('holds the different in hole delays a mixed shot uses', () => {
    const network = row(2);
    network.holes[1].inHoleDelayMs = 450;
    const resolved = resolveFiringTimes(network);
    expect(resolved.holes.map((hole) => hole.firingTimeMs)).toEqual([475, 500]);
    expect(resolved.holes[0].holeNumber).toBe(2);
  });
});

describe('findLoops', () => {
  it('finds nothing in a properly tied shot', () => {
    expect(findLoops(parseNetwork(row()))).toEqual([]);
  });

  it('finds a connector tied back up the row', () => {
    const network = row(4);
    network.connectors.push({ fromHole: 4, toHole: 2, delayMs: 25 });
    const loops = findLoops(parseNetwork(network));
    expect(loops).toHaveLength(1);
    expect(loops[0][0]).toBe(2);
    expect(loops[0].at(-1)).toBe(2);
  });

  it('finds a pair tied to each other', () => {
    const network = row(3);
    network.connectors.push({ fromHole: 3, toHole: 2, delayMs: 25 });
    expect(findLoops(parseNetwork(network))).toHaveLength(1);
  });

  it('is reported alongside the times rather than throwing', () => {
    const network = row(4);
    network.connectors.push({ fromHole: 4, toHole: 2, delayMs: 25 });
    const resolved = resolveFiringTimes(network);
    expect(resolved.loops).toHaveLength(1);
    expect(resolved.holes).toHaveLength(4);
  });
});

describe('firingOrder', () => {
  it('numbers the holes in the order they fire with the gap between them', () => {
    const order = firingOrder(resolveFiringTimes(row()));
    expect(order[0]).toEqual({
      position: 1,
      holeNumber: 1,
      firingTimeMs: 500,
      gapFromPreviousMs: null,
    });
    expect(order[1].gapFromPreviousMs).toBe(25);
  });

  it('shows a zero gap where two holes fire together', () => {
    const network = row(2);
    network.connectors = [{ fromHole: 1, toHole: 2, delayMs: 0 }];
    expect(firingOrder(resolveFiringTimes(network))[1].gapFromPreviousMs).toBe(0);
  });
});
