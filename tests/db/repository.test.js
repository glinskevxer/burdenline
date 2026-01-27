import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import {
  toCamel,
  toSnake,
  rowToObject,
  rowsToObjects,
  objectToRow,
  insertRow,
  updateRow,
  deleteRow,
  findById,
  getById,
  countWhere,
  listWhere,
  pageBounds,
  buildWhere,
  paging,
  createRecord,
  updateRecord,
} from '../../src/db/repository.js';
import { NotFoundError, ConflictError } from '../../src/lib/errors.js';

let db;

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  db.exec(`
    CREATE TABLE rig (
      id TEXT PRIMARY KEY,
      fleet_number TEXT NOT NULL UNIQUE,
      hole_diameter_mm REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      retired_at TEXT,
      CHECK (hole_diameter_mm > 0)
    )
  `);
});

afterEach(() => closeDatabase(db));

function seed() {
  insertRow(db, 'rig', { id: 'r1', fleetNumber: 'DR-01', holeDiameterMm: 102 });
  insertRow(db, 'rig', { id: 'r2', fleetNumber: 'DR-02', holeDiameterMm: 89, status: 'down' });
  insertRow(db, 'rig', { id: 'r3', fleetNumber: 'DR-03', holeDiameterMm: 115, status: 'down' });
}

describe('name conversion', () => {
  it('goes both ways', () => {
    expect(toCamel('hole_diameter_mm')).toBe('holeDiameterMm');
    expect(toSnake('holeDiameterMm')).toBe('hole_diameter_mm');
  });

  it('leaves a name that needs no change alone', () => {
    expect(toCamel('status')).toBe('status');
    expect(toSnake('status')).toBe('status');
  });

  it('handles a digit boundary', () => {
    expect(toCamel('grid_epsg_2157')).toBe('gridEpsg2157');
  });
});

describe('row mapping', () => {
  it('renames every column', () => {
    expect(rowToObject({ hole_number: 4, water_depth_m: null })).toEqual({
      holeNumber: 4,
      waterDepthM: null,
    });
  });

  it('passes a missing row through as null', () => {
    expect(rowToObject(undefined)).toBe(null);
    expect(rowToObject(null)).toBe(null);
  });

  it('maps a list', () => {
    expect(rowsToObjects([{ a_b: 1 }, { a_b: 2 }])).toEqual([{ aB: 1 }, { aB: 2 }]);
  });

  it('drops undefined on the way in but keeps null', () => {
    expect(objectToRow({ aB: undefined, cD: null, eF: 3 })).toEqual({ c_d: null, e_f: 3 });
  });
});

describe('insert', () => {
  it('writes an object with camel case fields', () => {
    insertRow(db, 'rig', { id: 'r1', fleetNumber: 'DR-01', holeDiameterMm: 102 });
    expect(db.prepare('SELECT fleet_number FROM rig').get().fleet_number).toBe('DR-01');
  });

  it('turns a unique clash into a conflict', () => {
    insertRow(db, 'rig', { id: 'r1', fleetNumber: 'DR-01', holeDiameterMm: 102 });
    expect(() =>
      insertRow(db, 'rig', { id: 'r2', fleetNumber: 'DR-01', holeDiameterMm: 102 }),
    ).toThrow(ConflictError);
  });

  it('turns a check failure into a conflict that names the columns', () => {
    try {
      insertRow(db, 'rig', { id: 'r1', fleetNumber: 'DR-01', holeDiameterMm: -5 });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect(error.details.keys).toContain('hole_diameter_mm');
    }
  });

  it('refuses an empty object', () => {
    expect(() => insertRow(db, 'rig', {})).toThrow(/nothing to insert/);
  });
});

describe('update and delete', () => {
  it('updates only the fields given', () => {
    seed();
    expect(updateRow(db, 'rig', 'r1', { status: 'down' })).toBe(1);
    expect(findById(db, 'rig', 'r1').status).toBe('down');
    expect(findById(db, 'rig', 'r1').fleetNumber).toBe('DR-01');
  });

  it('does nothing when there is nothing to change', () => {
    seed();
    expect(updateRow(db, 'rig', 'r1', {})).toBe(0);
  });

  it('reports no rows touched for an id that is not there', () => {
    expect(updateRow(db, 'rig', 'nope', { status: 'down' })).toBe(0);
    expect(deleteRow(db, 'rig', 'nope')).toBe(0);
  });

  it('deletes', () => {
    seed();
    expect(deleteRow(db, 'rig', 'r2')).toBe(1);
    expect(countWhere(db, 'rig')).toBe(2);
  });
});

describe('reads', () => {
  it('finds by id or returns null', () => {
    seed();
    expect(findById(db, 'rig', 'r1').fleetNumber).toBe('DR-01');
    expect(findById(db, 'rig', 'missing')).toBe(null);
  });

  it('throws a not found with the kind the caller named', () => {
    try {
      getById(db, 'rig', 'missing', { kind: 'drill rig' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.message).toBe('no drill rig with id missing');
    }
  });

  it('filters on equality', () => {
    seed();
    expect(listWhere(db, 'rig', { status: 'down' })).toHaveLength(2);
  });

  it('filters on a list of values', () => {
    seed();
    const found = listWhere(db, 'rig', { id: ['r1', 'r3'] }, { orderBy: 'id' });
    expect(found.map((row) => row.id)).toEqual(['r1', 'r3']);
  });

  it('reads an empty list as matching nothing', () => {
    seed();
    expect(listWhere(db, 'rig', { id: [] })).toEqual([]);
  });

  it('filters on null', () => {
    seed();
    expect(countWhere(db, 'rig', { retiredAt: null })).toBe(3);
  });

  it('ignores an undefined filter rather than matching null', () => {
    seed();
    expect(countWhere(db, 'rig', { status: undefined })).toBe(3);
  });
});

describe('paging', () => {
  it('defaults to the first page', () => {
    expect(pageBounds()).toEqual({ limit: 50, offset: 0, page: 1, pageSize: 50 });
  });

  it('caps a greedy page size', () => {
    expect(pageBounds({ pageSize: 100000 }).limit).toBe(paging.MAX_PAGE_SIZE);
  });

  it('treats a nonsense page as the first', () => {
    expect(pageBounds({ page: -3 }).offset).toBe(0);
    expect(pageBounds({ page: 'abc' }).page).toBe(1);
  });

  it('walks through a list', () => {
    seed();
    const firstPage = listWhere(db, 'rig', {}, { orderBy: 'id', page: 1, pageSize: 2 });
    const secondPage = listWhere(db, 'rig', {}, { orderBy: 'id', page: 2, pageSize: 2 });
    expect(firstPage.map((row) => row.id)).toEqual(['r1', 'r2']);
    expect(secondPage.map((row) => row.id)).toEqual(['r3']);
  });
});

describe('buildWhere', () => {
  it('returns nothing for an empty filter', () => {
    expect(buildWhere({})).toEqual({ clause: '', parameters: {} });
  });

  it('names parameters after the column', () => {
    const built = buildWhere({ holeDiameterMm: 102 });
    expect(built.clause).toBe('WHERE hole_diameter_mm = @hole_diameter_mm');
    expect(built.parameters).toEqual({ hole_diameter_mm: 102 });
  });
});

describe('createRecord', () => {
  beforeEach(() => {
    db.exec(`
      CREATE TABLE crew (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        shift TEXT NOT NULL DEFAULT 'day',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  });

  const clock = { now: () => '2026-01-14T09:00:00.000Z' };

  it('gives the record an id of the right prefix and both timestamps', () => {
    const record = createRecord(
      db,
      { table: 'crew', prefix: 'per' },
      { name: 'M Cronin' },
      { clock },
    );
    expect(record.id.startsWith('per_')).toBe(true);
    expect(record.createdAt).toBe('2026-01-14T09:00:00.000Z');
    expect(record.updatedAt).toBe(record.createdAt);
  });

  it('takes an id the caller supplied', () => {
    const record = createRecord(
      db,
      { table: 'crew', prefix: 'per' },
      { id: 'per_fixed', name: 'M Cronin' },
      { clock },
    );
    expect(record.id).toBe('per_fixed');
  });

  it('fills in the defaults and lets the caller override them', () => {
    const record = createRecord(
      db,
      { table: 'crew', prefix: 'per', defaults: { shift: 'day' } },
      { name: 'S Nolan', shift: 'night' },
      { clock },
    );
    expect(record.shift).toBe('night');
  });

  it('writes only the timestamps the table has', () => {
    db.exec(
      'CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL)',
    );
    const record = createRecord(
      db,
      { table: 'note', prefix: 'evt', timestamps: ['createdAt'] },
      { body: 'a line in the book' },
      { clock },
    );
    expect(record.createdAt).toBe('2026-01-14T09:00:00.000Z');
    expect(record.updatedAt).toBe(undefined);
  });

  it('drops a field the caller left undefined rather than writing null', () => {
    const record = createRecord(
      db,
      { table: 'crew', prefix: 'per', defaults: { shift: 'day' } },
      { name: 'S Nolan', shift: undefined },
      { clock },
    );
    expect(record.shift).toBe('day');
  });
});

describe('updateRecord', () => {
  const clock = { now: () => '2026-01-15T09:00:00.000Z' };

  beforeEach(() => {
    db.exec(`
      CREATE TABLE crew (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        shift TEXT NOT NULL DEFAULT 'day',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    createRecord(
      db,
      { table: 'crew', prefix: 'per' },
      { id: 'per_1', name: 'M Cronin' },
      { clock: { now: () => '2026-01-14T09:00:00.000Z' } },
    );
  });

  it('changes only the fields it is allowed to and moves the timestamp', () => {
    const updated = updateRecord(
      db,
      { table: 'crew', kind: 'crew member', updatable: ['shift'] },
      'per_1',
      { shift: 'night', name: 'Somebody Else' },
      { clock },
    );
    expect(updated.shift).toBe('night');
    expect(updated.name).toBe('M Cronin');
    expect(updated.updatedAt).toBe('2026-01-15T09:00:00.000Z');
  });

  it('leaves the timestamp alone when there is nothing to change', () => {
    const updated = updateRecord(
      db,
      { table: 'crew', kind: 'crew member', updatable: ['shift'] },
      'per_1',
      { name: 'Somebody Else' },
      { clock },
    );
    expect(updated.updatedAt).toBe('2026-01-14T09:00:00.000Z');
  });

  it('refuses a record that is not there and names the kind', () => {
    expect(() =>
      updateRecord(
        db,
        { table: 'crew', kind: 'crew member', updatable: ['shift'] },
        'per_9',
        {},
        { clock },
      ),
    ).toThrow(/no crew member with id per_9/);
  });
});
