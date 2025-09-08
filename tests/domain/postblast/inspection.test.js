import { describe, it, expect } from 'vitest';
import {
  parseInspection,
  parseMisfire,
  score,
  actionsRequired,
  trend,
  MUCKPILE_SHAPES,
  TOE_GRADES,
} from '../../../src/domain/postblast/inspection.js';
import { ValidationError } from '../../../src/lib/errors.js';

function inspection(overrides = {}) {
  return parseInspection({
    blastId: 'blast_1',
    inspectedAt: '2025-09-05T14:30:00.000Z',
    inspectedBy: 'per_1',
    muckpileShape: 'moderate',
    throwM: 12,
    toeGrade: 'none',
    backbreakM: 0.8,
    oversizeCount: 4,
    faceStable: true,
    ...overrides,
  });
}

describe('parseInspection', () => {
  it('takes a walked inspection', () => {
    expect(inspection().muckpileShape).toBe('moderate');
    expect(Object.isFrozen(inspection())).toBe(true);
  });

  it('defaults the things nobody wrote down', () => {
    expect(inspection().flyrockObserved).toBe(false);
    expect(inspection().fumeGrade).toBe(0);
    expect(inspection().muckpileHeightM).toBe(null);
  });

  it('refuses a muckpile shape nobody uses', () => {
    expect(() => inspection({ muckpileShape: 'flat' })).toThrow(ValidationError);
  });

  it('refuses a throw distance out of any sane range', () => {
    expect(() => inspection({ throwM: 500 })).toThrow(ValidationError);
  });

  it('names the vocabularies', () => {
    expect(MUCKPILE_SHAPES).toContain('cast');
    expect(TOE_GRADES).toEqual(['none', 'slight', 'moderate', 'severe']);
  });
});

describe('parseMisfire', () => {
  const misfire = {
    blastId: 'blast_1',
    holeNumbers: [14, 15],
    kind: 'unfired_hole',
    discoveredAt: '2025-09-05T14:40:00.000Z',
    discoveredBy: 'per_1',
    description: 'two holes in row three are standing with the tube unfired',
  };

  it('takes a misfire with the holes named', () => {
    expect(parseMisfire(misfire).holeNumbers).toEqual([14, 15]);
  });

  it('refuses one with no holes', () => {
    expect(() => parseMisfire({ ...misfire, holeNumbers: [] })).toThrow(ValidationError);
  });

  it('refuses a description that says nothing', () => {
    expect(() => parseMisfire({ ...misfire, description: 'bad' })).toThrow(ValidationError);
  });

  it('refuses a kind that is not one of the four', () => {
    expect(() => parseMisfire({ ...misfire, kind: 'noise' })).toThrow(ValidationError);
  });
});

describe('score', () => {
  it('scores a clean shot well', () => {
    const result = score(inspection(), { holeCount: 24 });
    expect(result.total).toBeGreaterThan(80);
    expect(result.grade).toBe('good');
  });

  it('marks a shot with severe toe down hard', () => {
    const result = score(inspection({ toeGrade: 'severe' }), { holeCount: 24 });
    expect(result.parts.toe).toBe(0);
    expect(result.total).toBeLessThan(80);
  });

  it('marks a shot with heavy backbreak down', () => {
    const clean = score(inspection(), { holeCount: 24 }).total;
    const broken = score(inspection({ backbreakM: 3.5 }), { holeCount: 24 }).total;
    expect(broken).toBeLessThan(clean);
  });

  it('counts oversize against the hole count', () => {
    const few = score(inspection({ oversizeCount: 4 }), { holeCount: 40 }).parts.fragmentation;
    const many = score(inspection({ oversizeCount: 40 }), { holeCount: 40 }).parts.fragmentation;
    expect(many).toBeLessThan(few);
  });

  it('never scores a part below zero', () => {
    const result = score(inspection({ backbreakM: 20, throwM: 120, oversizeCount: 900 }), {
      holeCount: 10,
    });
    expect(Math.min(...Object.values(result.parts))).toBeGreaterThanOrEqual(0);
  });

  it('follows weights the site chose', () => {
    const result = score(inspection({ toeGrade: 'severe' }), {
      holeCount: 24,
      weights: { fragmentation: 10, toe: 60, backbreak: 10, throw: 10, muckpile: 10 },
    });
    expect(result.total).toBeLessThan(50);
  });

  it('grades a bad shot poor', () => {
    const result = score(
      inspection({
        toeGrade: 'severe',
        backbreakM: 4,
        throwM: 45,
        oversizeCount: 60,
        muckpileShape: 'tight',
      }),
      { holeCount: 24 },
    );
    expect(result.grade).toBe('poor');
  });
});

describe('actionsRequired', () => {
  it('lets a clean shot be dug', () => {
    expect(actionsRequired(inspection()).diggable).toBe(true);
  });

  it('stops digging while a misfire stands', () => {
    const misfire = parseMisfire({
      blastId: 'blast_1',
      holeNumbers: [14],
      kind: 'unfired_hole',
      discoveredAt: '2025-09-05T14:40:00.000Z',
      discoveredBy: 'per_1',
      description: 'one hole in row three did not go off at all',
    });
    const result = actionsRequired(inspection(), [misfire]);
    expect(result.diggable).toBe(false);
    expect(result.violations[0].holes).toEqual([14]);
  });

  it('stops digging under an unstable face', () => {
    expect(actionsRequired(inspection({ faceStable: false })).diggable).toBe(false);
  });

  it('raises flyrock as its own finding', () => {
    const result = actionsRequired(inspection({ flyrockObserved: true }));
    expect(result.violations.map((v) => v.rule)).toContain('postblast.flyrock');
  });

  it('raises heavy fume', () => {
    expect(actionsRequired(inspection({ fumeGrade: 4 })).violations.map((v) => v.rule)).toContain(
      'postblast.fume',
    );
  });

  it('lets light fume pass', () => {
    expect(actionsRequired(inspection({ fumeGrade: 2 })).diggable).toBe(true);
  });

  it('calls for secondary breaking on severe toe', () => {
    expect(
      actionsRequired(inspection({ toeGrade: 'severe' })).violations.map((v) => v.rule),
    ).toContain('postblast.toe');
  });
});

describe('trend', () => {
  const inspections = [
    inspection({ blastId: 'blast_1' }),
    inspection({ blastId: 'blast_2', toeGrade: 'moderate', backbreakM: 2.4 }),
    inspection({ blastId: 'blast_3', toeGrade: 'severe', flyrockObserved: true, backbreakM: 3 }),
  ];

  it('averages the scores and names the best and worst', () => {
    const result = trend(inspections, { holeCount: 24 });
    expect(result.count).toBe(3);
    expect(result.best).toBe('blast_1');
    expect(result.worst).toBe('blast_3');
  });

  it('reports how often toe is a problem', () => {
    expect(trend(inspections, { holeCount: 24 }).toeRate).toBeCloseTo(0.667, 3);
  });

  it('counts flyrock events', () => {
    expect(trend(inspections, { holeCount: 24 }).flyrockCount).toBe(1);
  });

  it('averages backbreak', () => {
    expect(trend(inspections, { holeCount: 24 }).meanBackbreakM).toBeCloseTo(2.07, 2);
  });

  it('has nothing to say about an empty period', () => {
    expect(trend([])).toMatchObject({ count: 0, meanScore: null });
  });
});
