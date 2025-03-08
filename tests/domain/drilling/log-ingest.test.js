import { describe, it, expect } from 'vitest';
import {
  parseDrillLog,
  readCondition,
  reconcileDrilling,
  DEFAULT_TOLERANCES,
} from '../../../src/domain/drilling/log-ingest.js';
import { ValidationError } from '../../../src/lib/errors.js';

const log = [
  'Hole,Depth (m),Condition,Water (m),Operator',
  '1,16.1,dry,,S Nolan',
  '2,16.0,damp,0.4,S Nolan',
  '3,15.2,wet,3.1,S Nolan',
  '',
].join('\n');

const designed = [
  { holeNumber: 1, designedDepthM: 16 },
  { holeNumber: 2, designedDepthM: 16 },
  { holeNumber: 3, designedDepthM: 16 },
  { holeNumber: 4, designedDepthM: 16 },
];

describe('parseDrillLog', () => {
  it('reads a row per hole', () => {
    const rows = parseDrillLog(log);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ holeNumber: 1, drilledDepthM: 16.1, condition: 'dry' });
  });

  it('takes the several column names the rigs use', () => {
    const rows = parseDrillLog('hole_no,drilled_depth\n7,15.5\n');
    expect(rows[0]).toMatchObject({ holeNumber: 7, drilledDepthM: 15.5 });
  });

  it('keeps the water depth and the operator', () => {
    const rows = parseDrillLog(log);
    expect(rows[2].waterDepthM).toBe(3.1);
    expect(rows[2].operator).toBe('S Nolan');
    expect(rows[0].waterDepthM).toBe(null);
  });

  it('reads a missing depth as not drilled rather than zero', () => {
    expect(parseDrillLog('hole,depth\n5,\n')[0].drilledDepthM).toBe(null);
  });

  it('refuses an empty log', () => {
    expect(() => parseDrillLog('hole,depth\n')).toThrow(/empty/);
  });

  it('refuses a row with no hole number', () => {
    expect(() => parseDrillLog('hole,depth\n,16\n')).toThrow(ValidationError);
  });

  it('refuses a hole number that is not whole', () => {
    expect(() => parseDrillLog('hole,depth\n2.5,16\n')).toThrow(/hole number/);
  });

  it('refuses the same hole logged twice', () => {
    expect(() => parseDrillLog('hole,depth\n1,16\n1,15\n')).toThrow(/logged twice/);
  });
});

describe('readCondition', () => {
  it('maps the words operators actually type', () => {
    expect(readCondition('WET')).toBe('wet');
    expect(readCondition('moist near collar')).toBe('damp');
    expect(readCondition('hit a void')).toBe('cavity');
    expect(readCondition('caved in')).toBe('collapsed');
    expect(readCondition('abandoned')).toBe('lost');
  });

  it('reads nothing as dry', () => {
    expect(readCondition('')).toBe('dry');
    expect(readCondition(undefined)).toBe('dry');
    expect(readCondition('drilled ok')).toBe('dry');
  });
});

describe('reconcileDrilling', () => {
  it('puts every designed hole in exactly one bucket', () => {
    const result = reconcileDrilling(designed, parseDrillLog(log));
    const forDesigned = result.holes.filter((hole) => hole.outcome !== 'not_on_plan');
    expect(forDesigned).toHaveLength(4);
  });

  it('calls a hole within tolerance on plan', () => {
    const result = reconcileDrilling(designed, parseDrillLog(log));
    expect(result.holes[0].outcome).toBe('on_plan');
    expect(result.holes[0].varianceM).toBe(0.1);
  });

  it('flags a hole that is short', () => {
    const result = reconcileDrilling(designed, parseDrillLog(log));
    expect(result.holes[2].outcome).toBe('short');
    expect(result.holes[2].varianceM).toBe(-0.8);
  });

  it('calls for a redrill once a hole is a metre down', () => {
    const rows = parseDrillLog('hole,depth\n1,14.9\n');
    expect(reconcileDrilling([designed[0]], rows).holes[0].outcome).toBe('redrill');
  });

  it('flags a hole drilled well past the design', () => {
    const rows = parseDrillLog('hole,depth\n1,17.2\n');
    expect(reconcileDrilling([designed[0]], rows).holes[0].outcome).toBe('over');
  });

  it('calls a collapsed hole lost whatever depth it reached', () => {
    const rows = parseDrillLog('hole,depth,condition\n1,16.0,caved\n');
    expect(reconcileDrilling([designed[0]], rows).holes[0].outcome).toBe('lost');
  });

  it('reports a hole nobody drilled', () => {
    const result = reconcileDrilling(designed, parseDrillLog(log));
    expect(result.holes[3].outcome).toBe('not_drilled');
    expect(result.counts.not_drilled).toBe(1);
  });

  it('reports a hole that was never on the plan', () => {
    const rows = parseDrillLog('hole,depth\n1,16\n99,15.8\n');
    const result = reconcileDrilling([designed[0]], rows);
    expect(result.holes.at(-1)).toMatchObject({ holeNumber: 99, outcome: 'not_on_plan' });
  });

  it('adds up the metres actually drilled', () => {
    const result = reconcileDrilling(designed, parseDrillLog(log));
    expect(result.drilledMetres).toBe(47.3);
    expect(result.loggedCount).toBe(3);
    expect(result.designedCount).toBe(4);
  });

  it('reports the worst hole and the average', () => {
    const result = reconcileDrilling(designed, parseDrillLog(log));
    expect(result.worstShortM).toBe(-0.8);
    expect(result.meanVarianceM).toBeCloseTo(-0.233, 3);
  });

  it('counts the holes with water or a void in them', () => {
    expect(reconcileDrilling(designed, parseDrillLog(log)).wetHoles).toBe(1);
  });

  it('is not ready while a hole is missing or needs redrilling', () => {
    expect(reconcileDrilling(designed, parseDrillLog(log)).ready).toBe(false);
    const complete = parseDrillLog('hole,depth\n1,16\n2,16\n3,16\n4,16\n');
    expect(reconcileDrilling(designed, complete).ready).toBe(true);
  });

  it('takes tolerances from the site rather than the defaults', () => {
    const rows = parseDrillLog('hole,depth\n1,15.6\n');
    expect(reconcileDrilling([designed[0]], rows).holes[0].outcome).toBe('short');
    const loose = reconcileDrilling([designed[0]], rows, { tolerances: { shortM: 0.6 } });
    expect(loose.holes[0].outcome).toBe('on_plan');
  });

  it('publishes the defaults it uses', () => {
    expect(DEFAULT_TOLERANCES.shortM).toBe(0.3);
    expect(Object.isFrozen(DEFAULT_TOLERANCES)).toBe(true);
  });
});
