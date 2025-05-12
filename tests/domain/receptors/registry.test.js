import { describe, it, expect } from 'vitest';
import {
  parseReceptor,
  distanceToPattern,
  withDistances,
  nearest,
  within,
  notifiable,
  summarise,
  STRUCTURE_CLASSES,
} from '../../../src/domain/receptors/registry.js';
import { ValidationError } from '../../../src/lib/errors.js';

const holes = [
  { holeNumber: 1, easting: 1000, northing: 2000, collarLevelM: 84 },
  { holeNumber: 2, easting: 1000, northing: 2050, collarLevelM: 84 },
  { holeNumber: 3, easting: 1030, northing: 2050, collarLevelM: 84 },
];

const cottage = parseReceptor({
  id: 'rec_1',
  name: 'Keeper cottage',
  structureClass: 'older_dwelling',
  easting: 1200,
  northing: 2000,
  notifiable: true,
  monitored: true,
});

const depot = parseReceptor({
  id: 'rec_2',
  name: 'Council depot',
  structureClass: 'commercial',
  easting: 1600,
  northing: 2000,
  occupied: false,
});

const gasMain = parseReceptor({
  id: 'rec_3',
  name: 'Medium pressure gas main',
  structureClass: 'buried_service',
  easting: 1000,
  northing: 2400,
  occupied: false,
  limitMmPerSecond: 25,
});

const receptors = [cottage, depot, gasMain];

describe('parseReceptor', () => {
  it('takes a well formed receptor and freezes it', () => {
    expect(cottage.name).toBe('Keeper cottage');
    expect(Object.isFrozen(cottage)).toBe(true);
  });

  it('defaults a receptor to occupied and unmonitored', () => {
    const plain = parseReceptor({
      id: 'rec_9',
      name: 'Farmhouse',
      structureClass: 'dwelling',
      easting: 0,
      northing: 0,
    });
    expect(plain.occupied).toBe(true);
    expect(plain.monitored).toBe(false);
    expect(plain.limitMmPerSecond).toBe(null);
  });

  it('refuses a structure class nobody has a curve for', () => {
    expect(() =>
      parseReceptor({ id: 'r', name: 'Shed', structureClass: 'shed', easting: 0, northing: 0 }),
    ).toThrow(ValidationError);
  });

  it('refuses an airblast limit outside anything a monitor reads', () => {
    expect(() =>
      parseReceptor({
        id: 'r',
        name: 'House',
        structureClass: 'dwelling',
        easting: 0,
        northing: 0,
        airblastLimitDb: 40,
      }),
    ).toThrow(ValidationError);
  });

  it('lists every class it knows', () => {
    expect(STRUCTURE_CLASSES).toContain('buried_service');
    expect(STRUCTURE_CLASSES).toHaveLength(8);
  });
});

describe('distanceToPattern', () => {
  it('measures to the nearest hole, not the middle of the pattern', () => {
    const measured = distanceToPattern(cottage, holes);
    expect(measured.distanceM).toBe(177.2);
    expect(measured.holeNumber).toBe(3);
  });

  it('picks a different hole for a receptor on the other side', () => {
    const measured = distanceToPattern(gasMain, holes);
    expect(measured.holeNumber).toBe(2);
    expect(measured.distanceM).toBe(350);
  });

  it('ignores level, since the standards are written on plan distance', () => {
    const raised = parseReceptor({ ...cottage, id: 'rec_4', level: 200 });
    expect(distanceToPattern(raised, holes).distanceM).toBe(177.2);
  });

  it('refuses an empty pattern', () => {
    expect(() => distanceToPattern(cottage, [])).toThrow(/no holes to measure/);
  });
});

describe('withDistances', () => {
  it('sorts the receptors from the nearest out', () => {
    const measured = withDistances(receptors, holes);
    expect(measured.map((entry) => entry.receptor.id)).toEqual(['rec_1', 'rec_3', 'rec_2']);
  });

  it('names the hole each distance was measured to', () => {
    expect(withDistances(receptors, holes)[0].nearestHoleNumber).toBe(3);
  });
});

describe('nearest', () => {
  it('takes the closest few', () => {
    expect(nearest(receptors, holes, 2).map((entry) => entry.receptor.id)).toEqual([
      'rec_1',
      'rec_3',
    ]);
  });

  it('gives back everything when there are fewer than asked for', () => {
    expect(nearest(receptors, holes, 10)).toHaveLength(3);
  });

  it('refuses a count of zero', () => {
    expect(() => nearest(receptors, holes, 0)).toThrow(ValidationError);
  });
});

describe('within', () => {
  it('takes everything inside the radius', () => {
    expect(within(receptors, holes, 400).map((entry) => entry.receptor.id)).toEqual([
      'rec_1',
      'rec_3',
    ]);
  });

  it('includes a receptor exactly on the radius', () => {
    expect(within(receptors, holes, 177.2)).toHaveLength(1);
  });

  it('refuses a radius of zero', () => {
    expect(() => within(receptors, holes, 0)).toThrow(ValidationError);
  });
});

describe('notifiable', () => {
  it('takes the occupied and the flagged, and leaves the rest', () => {
    const list = notifiable(receptors, holes, 1000);
    expect(list.map((entry) => entry.receptor.id)).toEqual(['rec_1']);
  });

  it('includes an unoccupied receptor that is flagged anyway', () => {
    const flagged = parseReceptor({ ...gasMain, notifiable: true });
    const list = notifiable([flagged], holes, 1000);
    expect(list).toHaveLength(1);
  });
});

describe('summarise', () => {
  it('counts what sits around the pattern', () => {
    const summary = summarise(receptors, holes, 1000);
    expect(summary.count).toBe(3);
    expect(summary.byClass).toEqual({ older_dwelling: 1, commercial: 1, buried_service: 1 });
    expect(summary.nearest.receptor.id).toBe('rec_1');
    expect(summary.monitoredCount).toBe(1);
    expect(summary.occupiedCount).toBe(1);
  });

  it('comes back empty when nothing is in range', () => {
    const summary = summarise(receptors, holes, 50);
    expect(summary.count).toBe(0);
    expect(summary.nearest).toBe(null);
  });
});
