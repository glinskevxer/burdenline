import { describe, it, expect } from 'vitest';
import {
  chargeEvents,
  maximumInstantaneousCharge,
  windowProfile,
  totalCharge,
  summariseTiming,
  DEFAULT_WINDOW_MS,
} from '../../../src/domain/initiation/windows.js';
import { resolveFiringTimes } from '../../../src/domain/initiation/tie-in.js';
import { ValidationError } from '../../../src/lib/errors.js';

function row(holeCount, connectorMs) {
  return {
    initiationHole: 1,
    holes: Array.from({ length: holeCount }, (_unused, index) => ({
      holeNumber: index + 1,
      inHoleDelayMs: 500,
    })),
    connectors: Array.from({ length: holeCount - 1 }, (_unused, index) => ({
      fromHole: index + 1,
      toHole: index + 2,
      delayMs: connectorMs,
    })),
  };
}

function masses(holeCount, massKg) {
  return new Map(Array.from({ length: holeCount }, (_unused, index) => [index + 1, massKg]));
}

describe('chargeEvents', () => {
  it('makes one event per hole in a plain shot', () => {
    const events = chargeEvents(resolveFiringTimes(row(4, 25)), masses(4, 80));
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ holeNumber: 1, deck: 1, firingTimeMs: 500, massKg: 80 });
  });

  it('splits a decked hole into one event per deck', () => {
    const network = row(2, 25);
    network.holes[0] = { holeNumber: 1, inHoleDelayMs: 500, deckDelaysMs: [500, 560] };
    const events = chargeEvents(
      resolveFiringTimes(network),
      new Map([
        [1, [40, 30]],
        [2, 80],
      ]),
    );
    expect(events.filter((event) => event.holeNumber === 1)).toEqual([
      { holeNumber: 1, deck: 1, firingTimeMs: 500, massKg: 40 },
      { holeNumber: 1, deck: 2, firingTimeMs: 560, massKg: 30 },
    ]);
  });

  it('splits a single mass evenly across the decks when told no better', () => {
    const network = row(1, 25);
    network.holes[0] = { holeNumber: 1, inHoleDelayMs: 500, deckDelaysMs: [500, 560] };
    const events = chargeEvents(resolveFiringTimes(network), new Map([[1, 90]]));
    expect(events.map((event) => event.massKg)).toEqual([45, 45]);
  });

  it('refuses a hole with no mass on the load sheet', () => {
    expect(() => chargeEvents(resolveFiringTimes(row(3, 25)), masses(2, 80))).toThrow(
      /no charge mass for hole 3/,
    );
  });

  it('refuses a deck count that does not match the masses given', () => {
    const network = row(1, 25);
    network.holes[0] = { holeNumber: 1, inHoleDelayMs: 500, deckDelaysMs: [500, 560] };
    expect(() => chargeEvents(resolveFiringTimes(network), new Map([[1, [40, 30, 20]]]))).toThrow(
      ValidationError,
    );
  });

  it('sorts the events into firing order', () => {
    const events = chargeEvents(resolveFiringTimes(row(3, 25)), masses(3, 80));
    expect(events.map((event) => event.firingTimeMs)).toEqual([500, 525, 550]);
  });
});

describe('maximumInstantaneousCharge', () => {
  it('finds the single hole when they are well separated', () => {
    const events = chargeEvents(resolveFiringTimes(row(5, 25)), masses(5, 80));
    expect(maximumInstantaneousCharge(events).massKg).toBe(80);
  });

  it('adds up holes fired inside one window', () => {
    const events = chargeEvents(resolveFiringTimes(row(4, 0)), masses(4, 80));
    expect(maximumInstantaneousCharge(events).massKg).toBe(320);
  });

  it('slides rather than bucketing, so it catches a run that straddles a boundary', () => {
    const events = [
      { holeNumber: 1, deck: 1, firingTimeMs: 7, massKg: 50 },
      { holeNumber: 2, deck: 1, firingTimeMs: 9, massKg: 50 },
      { holeNumber: 3, deck: 1, firingTimeMs: 13, massKg: 50 },
    ];
    expect(maximumInstantaneousCharge(events, 8).massKg).toBe(150);
  });

  it('treats a charge exactly a window later as a separate pulse', () => {
    const events = [
      { holeNumber: 1, deck: 1, firingTimeMs: 0, massKg: 50 },
      { holeNumber: 2, deck: 1, firingTimeMs: 8, massKg: 60 },
    ];
    expect(maximumInstantaneousCharge(events, 8).massKg).toBe(60);
  });

  it('reports which holes made the heaviest window', () => {
    const events = chargeEvents(resolveFiringTimes(row(3, 4)), masses(3, 60));
    const heaviest = maximumInstantaneousCharge(events);
    expect(heaviest.massKg).toBe(120);
    expect(heaviest.events.map((event) => event.holeNumber)).toEqual([1, 2]);
    expect(heaviest.startMs).toBe(500);
    expect(heaviest.endMs).toBe(504);
  });

  it('follows a wider window when a regulator asks for one', () => {
    const events = chargeEvents(resolveFiringTimes(row(3, 10)), masses(3, 60));
    expect(maximumInstantaneousCharge(events, 8).massKg).toBe(60);
    expect(maximumInstantaneousCharge(events, 25).massKg).toBe(180);
  });

  it('reads an empty shot as no charge', () => {
    expect(maximumInstantaneousCharge([])).toEqual({
      massKg: 0,
      startMs: null,
      endMs: null,
      events: [],
    });
  });

  it('refuses a window of zero', () => {
    expect(() => maximumInstantaneousCharge([], 0)).toThrow(ValidationError);
  });
});

describe('windowProfile', () => {
  it('walks the shot in windows that carry charge', () => {
    const events = chargeEvents(resolveFiringTimes(row(4, 25)), masses(4, 80));
    const profile = windowProfile(events);
    expect(profile).toHaveLength(4);
    expect(profile[0]).toMatchObject({ startMs: 500, massKg: 80, holeCount: 1, deckCount: 1 });
  });

  it('gathers holes that fire together into one window', () => {
    const events = chargeEvents(resolveFiringTimes(row(4, 2)), masses(4, 80));
    const profile = windowProfile(events);
    expect(profile[0].holeCount).toBeGreaterThan(1);
    expect(profile.length).toBeLessThan(4);
  });
});

describe('summariseTiming', () => {
  it('rolls the whole timing picture up', () => {
    const resolved = resolveFiringTimes(row(5, 25));
    const summary = summariseTiming(resolved, masses(5, 80));
    expect(summary).toMatchObject({
      windowMs: DEFAULT_WINDOW_MS,
      totalMassKg: 400,
      maximumInstantaneousChargeKg: 80,
      holesInHeaviestWindow: 1,
      durationMs: 100,
    });
  });

  it('adds the total up the same way as the events', () => {
    const events = chargeEvents(resolveFiringTimes(row(3, 25)), masses(3, 77.5));
    expect(totalCharge(events)).toBe(232.5);
  });
});
