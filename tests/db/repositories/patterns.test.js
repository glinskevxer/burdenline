import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { migration as core } from '../../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../../src/db/migrations/004_operations.js';
import { migration as production } from '../../../src/db/migrations/005_production.js';
import { createSite, createBench } from '../../../src/db/repositories/sites.js';
import {
  createPattern,
  getPattern,
  findPattern,
  findPatternByReference,
  listPatterns,
  updatePattern,
  replaceHoles,
  listHoles,
  getHole,
  findHole,
  recordDrilling,
  holeCount,
} from '../../../src/db/repositories/patterns.js';
import { layoutPattern } from '../../../src/domain/geometry/pattern.js';
import { fixedClock } from '../../../src/lib/clock.js';
import { NotFoundError, ConflictError, ValidationError } from '../../../src/lib/errors.js';

let db;
let benchId;
const clock = fixedClock('2025-08-11T09:00:00Z');
const context = { clock };

const design = {
  origin: { easting: 1000, northing: 2000, level: 84 },
  faceBearingDeg: 0,
  layout: 'square',
  rowCount: 2,
  holesPerRow: 4,
  burdenM: 3,
  spacingM: 3.5,
  benchHeightM: 15,
  subdrillM: 1,
  inclinationDeg: 0,
  diameterMm: 102,
};

function pattern(overrides = {}) {
  return createPattern(
    db,
    {
      benchId,
      reference: 'MDW-2025-014',
      holeDiameterMm: 102,
      nominalBurdenM: 3,
      nominalSpacingM: 3.5,
      rowCount: 2,
      holesPerRow: 4,
      benchHeightM: 15,
      subdrillM: 1,
      ...overrides,
    },
    context,
  );
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations, production]);
  const site = createSite(db, { code: 'MDW', name: 'Midway' }, context);
  benchId = createBench(
    db,
    {
      siteId: site.id,
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
    },
    context,
  ).id;
});

afterEach(() => closeDatabase(db));

describe('patterns', () => {
  it('creates one in draft', () => {
    const created = pattern();
    expect(created.id.startsWith('pat_')).toBe(true);
    expect(created.status).toBe('draft');
  });

  it('refuses a pattern on a bench that is not there', () => {
    expect(() => pattern({ benchId: 'bench_missing' })).toThrow(NotFoundError);
  });

  it('finds one by reference', () => {
    pattern();
    expect(findPatternByReference(db, 'MDW-2025-014').holeDiameterMm).toBe(102);
    expect(findPatternByReference(db, 'nothing')).toBe(null);
  });

  it('lists the patterns on a bench', () => {
    pattern();
    pattern({ id: 'pat_2', reference: 'MDW-2025-015' });
    expect(listPatterns(db, benchId)).toHaveLength(2);
  });

  it('updates a draft pattern', () => {
    const created = pattern();
    expect(updatePattern(db, created.id, { nominalBurdenM: 3.2 }, context).nominalBurdenM).toBe(
      3.2,
    );
  });

  it('refuses to change a pattern that has been fired', () => {
    const created = pattern();
    updatePattern(db, created.id, { status: 'fired' }, context);
    expect(() => updatePattern(db, created.id, { nominalBurdenM: 4 }, context)).toThrow(
      ConflictError,
    );
  });

  it('reads a missing pattern as null or throws, depending which is asked', () => {
    expect(findPattern(db, 'pat_missing')).toBe(null);
    expect(() => getPattern(db, 'pat_missing')).toThrow(NotFoundError);
  });
});

describe('replaceHoles', () => {
  it('writes the whole laid out pattern', () => {
    const created = pattern();
    const { holes } = layoutPattern(design);
    const result = replaceHoles(db, created.id, holes, context);
    expect(result.holeCount).toBe(8);
    expect(holeCount(db, created.id)).toBe(8);
  });

  it('numbers and orders them the way they were laid out', () => {
    const created = pattern();
    replaceHoles(db, created.id, layoutPattern(design).holes, context);
    expect(listHoles(db, created.id).map((hole) => hole.holeNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('replaces what was there rather than adding to it', () => {
    const created = pattern();
    replaceHoles(db, created.id, layoutPattern(design).holes, context);
    replaceHoles(db, created.id, layoutPattern({ ...design, holesPerRow: 2 }).holes, context);
    expect(holeCount(db, created.id)).toBe(4);
  });

  it('writes nothing at all when one hole is bad', () => {
    const created = pattern();
    const holes = layoutPattern(design).holes;
    holes[3] = { ...holes[3], diameterMm: -5 };
    expect(() => replaceHoles(db, created.id, holes, context)).toThrow();
    expect(holeCount(db, created.id)).toBe(0);
  });

  it('refuses an empty pattern', () => {
    expect(() => replaceHoles(db, pattern().id, [], context)).toThrow(ValidationError);
  });

  it('refuses a pattern that is not there', () => {
    expect(() => replaceHoles(db, 'pat_missing', layoutPattern(design).holes, context)).toThrow(
      NotFoundError,
    );
  });
});

describe('reading holes', () => {
  it('finds one by its number in the pattern', () => {
    const created = pattern();
    replaceHoles(db, created.id, layoutPattern(design).holes, context);
    const hole = findHole(db, created.id, 5);
    expect(hole.rowNumber).toBe(2);
    expect(getHole(db, hole.id).holeNumber).toBe(5);
  });

  it('reads a hole that is not there as null', () => {
    const created = pattern();
    replaceHoles(db, created.id, layoutPattern(design).holes, context);
    expect(findHole(db, created.id, 99)).toBe(null);
  });

  it('pages through a big pattern', () => {
    const created = pattern();
    replaceHoles(db, created.id, layoutPattern({ ...design, holesPerRow: 20 }).holes, context);
    expect(listHoles(db, created.id, { limit: 10 })).toHaveLength(10);
    expect(listHoles(db, created.id, { limit: 10, offset: 35 })).toHaveLength(5);
  });
});

describe('recordDrilling', () => {
  function drilled() {
    const created = pattern();
    replaceHoles(db, created.id, layoutPattern(design).holes, context);
    return created.id;
  }

  it('writes the depths the rig reported', () => {
    const patternId = drilled();
    const result = recordDrilling(
      db,
      patternId,
      [
        { holeNumber: 1, drilledDepthM: 16.1, condition: 'dry' },
        { holeNumber: 2, drilledDepthM: 15.9, condition: 'wet', waterDepthM: 3.2 },
      ],
      context,
    );
    expect(result.updated).toBe(2);
    expect(findHole(db, patternId, 1).drilledDepthM).toBe(16.1);
    expect(findHole(db, patternId, 2).waterDepthM).toBe(3.2);
  });

  it('moves a hole to drilled once it has a depth', () => {
    const patternId = drilled();
    recordDrilling(db, patternId, [{ holeNumber: 1, drilledDepthM: 16.1 }], context);
    expect(findHole(db, patternId, 1).status).toBe('drilled');
  });

  it('leaves a hole with no depth as planned', () => {
    const patternId = drilled();
    recordDrilling(db, patternId, [{ holeNumber: 1, drilledDepthM: null }], context);
    expect(findHole(db, patternId, 1).status).toBe('planned');
  });

  it('reports a hole number that is not in the pattern', () => {
    const patternId = drilled();
    const result = recordDrilling(db, patternId, [{ holeNumber: 99, drilledDepthM: 16 }], context);
    expect(result.missing).toEqual([99]);
    expect(result.updated).toBe(0);
  });
});
