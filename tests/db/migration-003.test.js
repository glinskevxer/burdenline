import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { insertRow, findById } from '../../src/db/repository.js';
import { ConflictError } from '../../src/lib/errors.js';

let db;
const NOW = '2025-08-01T09:00:00.000Z';

function seedSite() {
  insertRow(db, 'site', {
    id: 'site_1',
    code: 'MDW',
    name: 'Midway',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return 'site_1';
}

function seedPerson(overrides = {}) {
  insertRow(db, 'person', {
    id: 'per_1',
    name: 'M Cronin',
    roles: 'shotfirer,charge_hand',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  return overrides.id ?? 'per_1';
}

function seedBlast(siteId, overrides = {}) {
  insertRow(db, 'blast', {
    id: 'blast_1',
    siteId,
    reference: 'MDW-2025-014',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  return overrides.id ?? 'blast_1';
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations]);
});

afterEach(() => closeDatabase(db));

describe('the blasting tables', () => {
  it('creates them all', () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    for (const table of [
      'person',
      'certificate',
      'receptor',
      'blast',
      'blast_event',
      'charge_deck',
      'tie_in_connector',
      'clearance_item',
      'monitor_record',
      'site_law',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('runs on top of the earlier migrations', () => {
    expect(
      db
        .prepare('SELECT id FROM schema_migration ORDER BY id')
        .all()
        .map((r) => r.id),
    ).toEqual(['001', '002', '003', '004']);
  });
});

describe('blast constraints', () => {
  it('starts a blast in draft', () => {
    const siteId = seedSite();
    seedBlast(siteId);
    expect(findById(db, 'blast', 'blast_1').state).toBe('draft');
  });

  it('refuses a state that is not in the machine', () => {
    const siteId = seedSite();
    expect(() => seedBlast(siteId, { state: 'exploded' })).toThrow(ConflictError);
  });

  it('keeps the shot reference unique', () => {
    const siteId = seedSite();
    seedBlast(siteId);
    expect(() => seedBlast(siteId, { id: 'blast_2' })).toThrow(ConflictError);
  });

  it('will not let a site with a blast on it be deleted', () => {
    const siteId = seedSite();
    seedBlast(siteId);
    expect(() => db.prepare('DELETE FROM site WHERE id = ?').run(siteId)).toThrow(/FOREIGN KEY/);
  });

  it('leaves the pattern behind when the pattern goes', () => {
    const siteId = seedSite();
    insertRow(db, 'bench', {
      id: 'bench_1',
      siteId,
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
      createdAt: NOW,
      updatedAt: NOW,
    });
    insertRow(db, 'pattern', {
      id: 'pat_1',
      benchId: 'bench_1',
      reference: 'MDW-2025-014-P',
      holeDiameterMm: 102,
      nominalBurdenM: 3,
      nominalSpacingM: 3.5,
      rowCount: 3,
      holesPerRow: 8,
      benchHeightM: 15,
      createdAt: NOW,
      updatedAt: NOW,
    });
    seedBlast(siteId, { patternId: 'pat_1' });
    db.prepare('DELETE FROM pattern WHERE id = ?').run('pat_1');
    expect(findById(db, 'blast', 'blast_1').patternId).toBe(null);
  });
});

describe('event and deck constraints', () => {
  it('appends events against a blast', () => {
    const siteId = seedSite();
    const personId = seedPerson();
    seedBlast(siteId);
    insertRow(db, 'blast_event', {
      id: 'evt_1',
      blastId: 'blast_1',
      action: 'complete_design',
      stateFrom: 'draft',
      stateTo: 'designed',
      occurredAt: NOW,
      actorId: personId,
      createdAt: NOW,
    });
    expect(db.prepare('SELECT count(*) AS n FROM blast_event').get().n).toBe(1);
  });

  it('takes the events away with the blast', () => {
    const siteId = seedSite();
    seedBlast(siteId);
    insertRow(db, 'blast_event', {
      id: 'evt_1',
      blastId: 'blast_1',
      action: 'complete_design',
      stateFrom: 'draft',
      stateTo: 'designed',
      occurredAt: NOW,
      createdAt: NOW,
    });
    db.prepare('DELETE FROM blast WHERE id = ?').run('blast_1');
    expect(db.prepare('SELECT count(*) AS n FROM blast_event').get().n).toBe(0);
  });

  it('refuses a deck that ends before it starts', () => {
    const siteId = seedSite();
    seedBlast(siteId);
    expect(() =>
      insertRow(db, 'charge_deck', {
        id: 'deck_1',
        blastId: 'blast_1',
        holeId: 'hole_1',
        deckNumber: 1,
        kind: 'charge',
        fromToeM: 5,
        toToeM: 2,
        createdAt: NOW,
      }),
    ).toThrow(ConflictError);
  });

  it('refuses a connector from a hole to itself', () => {
    const siteId = seedSite();
    seedBlast(siteId);
    expect(() =>
      insertRow(db, 'tie_in_connector', {
        id: 'tie_1',
        blastId: 'blast_1',
        fromHole: 4,
        toHole: 4,
        delayMs: 25,
        createdAt: NOW,
      }),
    ).toThrow(ConflictError);
  });
});

describe('monitoring constraints', () => {
  it('keeps one record per monitor per trigger time', () => {
    const siteId = seedSite();
    const record = {
      id: 'mon_1',
      siteId,
      monitorSerial: 'BE-11482',
      triggeredAt: NOW,
      peakMmPerSecond: 3.1,
      createdAt: NOW,
    };
    insertRow(db, 'monitor_record', record);
    expect(() => insertRow(db, 'monitor_record', { ...record, id: 'mon_2' })).toThrow(
      ConflictError,
    );
  });

  it('keeps the record when its receptor is deleted', () => {
    const siteId = seedSite();
    insertRow(db, 'receptor', {
      id: 'rec_1',
      siteId,
      name: 'Keeper cottage',
      structureClass: 'dwelling',
      eastingM: 1200,
      northingM: 2000,
      createdAt: NOW,
      updatedAt: NOW,
    });
    insertRow(db, 'monitor_record', {
      id: 'mon_1',
      siteId,
      receptorId: 'rec_1',
      monitorSerial: 'BE-11482',
      triggeredAt: NOW,
      peakMmPerSecond: 3.1,
      createdAt: NOW,
    });
    db.prepare('DELETE FROM receptor WHERE id = ?').run('rec_1');
    expect(findById(db, 'monitor_record', 'mon_1').receptorId).toBe(null);
  });

  it('refuses a site law with a negative exponent', () => {
    const siteId = seedSite();
    expect(() =>
      insertRow(db, 'site_law', {
        id: 'law_1',
        siteId,
        k: 1140,
        b: -1.6,
        recordCount: 20,
        fittedAt: NOW,
        createdAt: NOW,
      }),
    ).toThrow(ConflictError);
  });
});

describe('certificate constraints', () => {
  it('refuses a certificate that expires before it was issued', () => {
    const personId = seedPerson();
    expect(() =>
      insertRow(db, 'certificate', {
        id: 'cert_1',
        personId,
        kind: 'shotfirer',
        issuedOn: '2025-01-01',
        expiresOn: '2024-01-01',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow(ConflictError);
  });

  it('takes certificates away with the person', () => {
    const personId = seedPerson();
    insertRow(db, 'certificate', {
      id: 'cert_1',
      personId,
      kind: 'shotfirer',
      issuedOn: '2023-01-01',
      expiresOn: '2028-01-01',
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.prepare('DELETE FROM person WHERE id = ?').run(personId);
    expect(db.prepare('SELECT count(*) AS n FROM certificate').get().n).toBe(0);
  });
});
