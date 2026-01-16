import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { migration as core } from '../../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../../src/db/migrations/004_operations.js';
import { migration as production } from '../../../src/db/migrations/005_production.js';
import { createSite, createBench } from '../../../src/db/repositories/sites.js';
import { createPattern, replaceHoles, listHoles } from '../../../src/db/repositories/patterns.js';
import {
  createBlast,
  getBlast,
  findBlast,
  findBlastByReference,
  listBlasts,
  eventsFor,
  transition,
  recordDesignTotals,
  replaceDecks,
  decksFor,
  replaceTieIn,
  tieInFor,
  blastCount,
} from '../../../src/db/repositories/blasts.js';
import { layoutPattern } from '../../../src/domain/geometry/pattern.js';
import { fixedClock } from '../../../src/lib/clock.js';
import { NotFoundError, ConflictError, StateError } from '../../../src/lib/errors.js';
import { insertRow } from '../../../src/db/repository.js';

let db;
let siteId;
let patternId;
let holes;
const clock = fixedClock('2025-08-14T09:00:00Z');
const context = { clock };

function blast(overrides = {}) {
  return createBlast(db, { siteId, patternId, reference: 'MDW-2025-014', ...overrides }, context);
}

function approve(id) {
  transition(db, id, 'complete_design', {}, context);
  transition(db, id, 'submit', {}, context);
  return transition(db, id, 'approve', { approverId: 'per_9' }, context);
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations, production]);
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, context).id;
  for (const [id, name] of [
    ['per_1', 'M Cronin'],
    ['per_9', 'J Ryan'],
  ]) {
    insertRow(db, 'person', {
      id,
      name,
      roles: 'shotfirer',
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
  }
  const benchId = createBench(
    db,
    {
      siteId,
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
    },
    context,
  ).id;
  patternId = createPattern(
    db,
    {
      benchId,
      reference: 'MDW-2025-014-P',
      holeDiameterMm: 102,
      nominalBurdenM: 3,
      nominalSpacingM: 3.5,
      rowCount: 2,
      holesPerRow: 3,
      benchHeightM: 15,
    },
    context,
  ).id;
  replaceHoles(
    db,
    patternId,
    layoutPattern({
      origin: { easting: 1000, northing: 2000, level: 84 },
      faceBearingDeg: 0,
      layout: 'square',
      rowCount: 2,
      holesPerRow: 3,
      burdenM: 3,
      spacingM: 3.5,
      benchHeightM: 15,
      subdrillM: 1,
      diameterMm: 102,
    }).holes,
    context,
  );
  holes = listHoles(db, patternId);
});

afterEach(() => closeDatabase(db));

describe('blasts', () => {
  it('creates one in draft', () => {
    const created = blast();
    expect(created.state).toBe('draft');
    expect(created.id.startsWith('blast_')).toBe(true);
  });

  it('refuses a blast on a site that is not there', () => {
    expect(() => blast({ siteId: 'site_missing' })).toThrow(NotFoundError);
  });

  it('refuses two shots with the same reference', () => {
    blast();
    expect(() => blast()).toThrow(ConflictError);
  });

  it('finds one by reference', () => {
    const created = blast();
    expect(findBlastByReference(db, 'MDW-2025-014').id).toBe(created.id);
    expect(findBlastByReference(db, 'nothing')).toBe(null);
  });

  it('lists them by state', () => {
    const first = blast();
    blast({ reference: 'MDW-2025-015' });
    approve(first.id);
    expect(listBlasts(db, siteId, { state: 'approved' })).toHaveLength(1);
    expect(blastCount(db, siteId)).toBe(2);
  });

  it('reads a missing blast as null', () => {
    expect(findBlast(db, 'blast_missing')).toBe(null);
  });
});

describe('transitions', () => {
  it('writes the event and the state together', () => {
    const created = blast();
    const { blast: moved, event } = transition(db, created.id, 'complete_design', {}, context);
    expect(moved.state).toBe('designed');
    expect(event.stateFrom).toBe('draft');
    expect(eventsFor(db, created.id)).toHaveLength(1);
  });

  it('refuses a move the machine does not allow', () => {
    const created = blast();
    expect(() => transition(db, created.id, 'fire', { shotfirerId: 'per_1' }, context)).toThrow(
      StateError,
    );
  });

  it('leaves nothing behind when it refuses', () => {
    const created = blast();
    try {
      transition(db, created.id, 'fire', { shotfirerId: 'per_1' }, context);
    } catch {
      // expected
    }
    expect(eventsFor(db, created.id)).toHaveLength(0);
    expect(getBlast(db, created.id).state).toBe('draft');
  });

  it('records who approved a shot on the row as well as the event', () => {
    const created = blast();
    const { blast: approved } = approve(created.id);
    expect(approved.approvedBy).toBe('per_9');
    expect(eventsFor(db, created.id)).toHaveLength(3);
  });

  it('stamps the firing time and the shotfirer', () => {
    const created = blast();
    approve(created.id);
    transition(db, created.id, 'load', { shotfirerId: 'per_1' }, context);
    transition(db, created.id, 'tie_in', {}, context);
    transition(db, created.id, 'clear', { clearanceId: 'chk_1' }, context);
    const { blast: fired } = transition(
      db,
      created.id,
      'fire',
      { shotfirerId: 'per_1', firedAt: '2025-08-14T13:05:00.000Z' },
      context,
    );
    expect(fired.firedAt).toBe('2025-08-14T13:05:00.000Z');
    expect(fired.shotfirerId).toBe('per_1');
  });

  it('keeps the reason on a rejection', () => {
    const created = blast();
    transition(db, created.id, 'complete_design', {}, context);
    transition(db, created.id, 'submit', {}, context);
    transition(db, created.id, 'reject', { reason: 'row one burden too thin' }, context);
    expect(eventsFor(db, created.id).at(-1).reason).toContain('burden');
  });

  it('keeps a payload against the event', () => {
    const created = blast();
    transition(db, created.id, 'complete_design', { payload: { holes: 6 } }, context);
    expect(JSON.parse(eventsFor(db, created.id)[0].payload)).toEqual({ holes: 6 });
  });
});

describe('design totals', () => {
  it('writes them onto the blast', () => {
    const created = blast();
    const updated = recordDesignTotals(
      db,
      created.id,
      {
        totalChargeKg: 520,
        instantaneousChargeKg: 86,
        holeCount: 6,
        volumeM3: 945,
        powderFactorKgM3: 0.55,
      },
      context,
    );
    expect(updated.totalChargeKg).toBe(520);
    expect(updated.powderFactorKgM3).toBe(0.55);
  });

  it('refuses to change the totals of a fired shot', () => {
    const created = blast();
    approve(created.id);
    transition(db, created.id, 'load', { shotfirerId: 'per_1' }, context);
    transition(db, created.id, 'tie_in', {}, context);
    transition(db, created.id, 'clear', { clearanceId: 'chk_1' }, context);
    transition(db, created.id, 'fire', { shotfirerId: 'per_1', firedAt: clock.now() }, context);
    expect(() => recordDesignTotals(db, created.id, { totalChargeKg: 1 }, context)).toThrow(
      ConflictError,
    );
  });
});

describe('decks and tie-in', () => {
  it('writes one row per deck and reads them in hole order', () => {
    const created = blast();
    const decks = holes.flatMap((hole) => [
      {
        holeId: hole.id,
        deckNumber: 1,
        kind: 'charge',
        fromToeM: 0,
        toToeM: 13,
        massKg: 85,
        primed: true,
        boosterCount: 1,
      },
      { holeId: hole.id, deckNumber: 2, kind: 'stemming', fromToeM: 13, toToeM: 16 },
    ]);
    expect(replaceDecks(db, created.id, decks, context).deckCount).toBe(12);
    const written = decksFor(db, created.id);
    expect(written[0].holeNumber).toBe(1);
    expect(written[0].primed).toBe(1);
  });

  it('replaces the load sheet rather than adding to it', () => {
    const created = blast();
    const deck = {
      holeId: holes[0].id,
      deckNumber: 1,
      kind: 'charge',
      fromToeM: 0,
      toToeM: 13,
      massKg: 85,
    };
    replaceDecks(db, created.id, [deck], context);
    replaceDecks(db, created.id, [deck], context);
    expect(decksFor(db, created.id)).toHaveLength(1);
  });

  it('writes and reads the tie-in', () => {
    const created = blast();
    replaceTieIn(
      db,
      created.id,
      [
        { fromHole: 1, toHole: 2, delayMs: 25, detonatorCode: 'SC-25' },
        { fromHole: 2, toHole: 3, delayMs: 25 },
      ],
      context,
    );
    const connectors = tieInFor(db, created.id);
    expect(connectors).toHaveLength(2);
    expect(connectors[0].detonatorCode).toBe('SC-25');
  });

  it('refuses a tie-in on a blast that is not there', () => {
    expect(() => replaceTieIn(db, 'blast_missing', [], context)).toThrow(NotFoundError);
  });
});
