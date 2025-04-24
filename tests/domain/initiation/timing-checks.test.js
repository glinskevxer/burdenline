import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TIMING_RULES,
  timingRules,
  findNeighbours,
  checkTiming,
  checkRowRelief,
  checkWindowCrowding,
} from '../../../src/domain/initiation/timing-checks.js';
import { resolveFiringTimes } from '../../../src/domain/initiation/tie-in.js';

/** Two rows of three, three metres apart along the row and three between rows. */
const holes = [
  { holeNumber: 1, rowNumber: 1, easting: 0, northing: 0 },
  { holeNumber: 2, rowNumber: 1, easting: 0, northing: 3.5 },
  { holeNumber: 3, rowNumber: 1, easting: 0, northing: 7 },
  { holeNumber: 4, rowNumber: 2, easting: 3, northing: 0 },
  { holeNumber: 5, rowNumber: 2, easting: 3, northing: 3.5 },
  { holeNumber: 6, rowNumber: 2, easting: 3, northing: 7 },
];

function network(connectors, inHoleDelayMs = 500) {
  return {
    initiationHole: 1,
    holes: holes.map((hole) => ({ holeNumber: hole.holeNumber, inHoleDelayMs })),
    connectors,
  };
}

const alongRowThenBack = [
  { fromHole: 1, toHole: 2, delayMs: 25 },
  { fromHole: 2, toHole: 3, delayMs: 25 },
  { fromHole: 1, toHole: 4, delayMs: 100 },
  { fromHole: 4, toHole: 5, delayMs: 25 },
  { fromHole: 5, toHole: 6, delayMs: 25 },
];

describe('the rule set', () => {
  it('is frozen and overridable one number at a time', () => {
    expect(Object.isFrozen(timingRules())).toBe(true);
    expect(timingRules({ neighbourRadiusM: 10 }).minimumInterHoleMsPerMetre).toBe(
      DEFAULT_TIMING_RULES.minimumInterHoleMsPerMetre,
    );
  });
});

describe('findNeighbours', () => {
  it('pairs holes inside the radius only', () => {
    const pairs = findNeighbours(holes, 4);
    expect(pairs.every((pair) => pair.distanceM <= 4)).toBe(true);
    expect(pairs.some((pair) => pair.a.holeNumber === 1 && pair.b.holeNumber === 3)).toBe(false);
  });

  it('knows which pairs are in the same row', () => {
    const pairs = findNeighbours(holes, 4);
    const alongRow = pairs.find((pair) => pair.a.holeNumber === 1 && pair.b.holeNumber === 2);
    const acrossRows = pairs.find((pair) => pair.a.holeNumber === 1 && pair.b.holeNumber === 4);
    expect(alongRow.sameRow).toBe(true);
    expect(acrossRows.sameRow).toBe(false);
  });

  it('measures the distance between them', () => {
    const pairs = findNeighbours(holes, 4);
    expect(pairs.find((pair) => pair.a.holeNumber === 1 && pair.b.holeNumber === 4).distanceM).toBe(
      3,
    );
  });
});

describe('checkTiming', () => {
  it('passes a shot tied along the row and back', () => {
    const resolved = resolveFiringTimes(network(alongRowThenBack));
    expect(checkTiming(resolved, holes).valid).toBe(true);
  });

  it('catches neighbours in the same row fired too close together', () => {
    const tight = alongRowThenBack.map((connector) =>
      connector.fromHole <= 2 && connector.toHole <= 3 ? { ...connector, delayMs: 5 } : connector,
    );
    const result = checkTiming(resolveFiringTimes(network(tight)), holes);
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe('timing.inter_hole');
  });

  it('wants more time between rows than along a row', () => {
    const tight = alongRowThenBack.map((connector) =>
      connector.fromHole === 1 && connector.toHole === 4
        ? { ...connector, delayMs: 17 }
        : connector,
    );
    const result = checkTiming(resolveFiringTimes(network(tight)), holes);
    expect(result.violations.map((violation) => violation.rule)).toContain('timing.inter_row');
  });

  it('names both holes in the pair', () => {
    const tight = [{ fromHole: 1, toHole: 2, delayMs: 0 }];
    const result = checkTiming(resolveFiringTimes(network(tight)), holes);
    expect(result.violations[0].holes).toEqual([1, 2]);
  });

  it('reports a hole nobody tied in', () => {
    const resolved = resolveFiringTimes(network([{ fromHole: 1, toHole: 2, delayMs: 25 }]));
    const result = checkTiming(resolved, holes);
    expect(result.violations.filter((v) => v.rule === 'timing.unreachable')).toHaveLength(4);
  });

  it('reports a loop in the tie-in', () => {
    const looped = [...alongRowThenBack, { fromHole: 6, toHole: 4, delayMs: 25 }];
    const result = checkTiming(resolveFiringTimes(network(looped)), holes);
    expect(result.violations.map((v) => v.rule)).toContain('timing.loop');
  });

  it('reports a shot that runs on too long', () => {
    const slow = alongRowThenBack.map((connector) => ({ ...connector, delayMs: 2000 }));
    const result = checkTiming(resolveFiringTimes(network(slow)), holes);
    expect(result.violations.map((v) => v.rule)).toContain('timing.too_long');
  });

  it('follows a site that runs tighter timing', () => {
    const tight = [{ fromHole: 1, toHole: 2, delayMs: 9 }];
    const strict = checkTiming(resolveFiringTimes(network(tight)), holes, {
      rules: { minimumInterHoleMsPerMetre: 5 },
    });
    expect(strict.violations.some((v) => v.rule === 'timing.inter_hole')).toBe(true);
  });
});

describe('checkRowRelief', () => {
  it('passes when the back row waits for the front row', () => {
    const resolved = resolveFiringTimes(network(alongRowThenBack));
    expect(checkRowRelief(resolved, holes, { burdenM: 3 }).valid).toBe(true);
  });

  it('catches a back row starting before the front row has finished', () => {
    const early = alongRowThenBack.map((connector) =>
      connector.fromHole === 1 && connector.toHole === 4 ? { ...connector, delayMs: 0 } : connector,
    );
    const result = checkRowRelief(resolveFiringTimes(network(early)), holes, { burdenM: 3 });
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe('timing.row_relief');
  });

  it('measures from the latest hole in the front row', () => {
    const resolved = resolveFiringTimes(network(alongRowThenBack));
    const result = checkRowRelief(resolved, holes, { burdenM: 3 });
    expect(result.rows[0].latest).toBe(550);
    expect(result.rows[1].earliest).toBe(600);
  });

  it('has nothing to check on a single row shot', () => {
    const singleRow = holes.filter((hole) => hole.rowNumber === 1);
    const resolved = resolveFiringTimes({
      initiationHole: 1,
      holes: singleRow.map((hole) => ({ holeNumber: hole.holeNumber, inHoleDelayMs: 500 })),
      connectors: [
        { fromHole: 1, toHole: 2, delayMs: 25 },
        { fromHole: 2, toHole: 3, delayMs: 25 },
      ],
    });
    expect(checkRowRelief(resolved, singleRow).valid).toBe(true);
  });
});

describe('checkWindowCrowding', () => {
  it('says nothing about ordinary windows', () => {
    expect(checkWindowCrowding([{ startMs: 500, holeCount: 2 }])).toEqual([]);
  });

  it('flags a window with too many holes in it', () => {
    const violations = checkWindowCrowding([{ startMs: 500, holeCount: 7 }]);
    expect(violations[0].rule).toBe('timing.window_crowded');
    expect(violations[0].actual).toBe(7);
  });

  it('follows a tighter limit from the site', () => {
    expect(
      checkWindowCrowding([{ startMs: 0, holeCount: 3 }], { rules: { maximumHolesPerWindow: 2 } }),
    ).toHaveLength(1);
  });
});
