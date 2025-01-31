import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import {
  ensureMigrationTable,
  appliedMigrations,
  pendingMigrations,
  runMigrations,
  schemaVersion,
  checksumOf,
} from '../../src/db/migrate.js';
import { AppError } from '../../src/lib/errors.js';

const opened = [];

function open() {
  const db = openDatabase({ database: { file: ':memory:' } });
  opened.push(db);
  return db;
}

afterEach(() => {
  while (opened.length) {
    closeDatabase(opened.pop());
  }
});

const first = {
  id: '001',
  name: 'sites',
  up: (db) => db.exec('CREATE TABLE site (id TEXT PRIMARY KEY, code TEXT NOT NULL)'),
};
const second = {
  id: '002',
  name: 'benches',
  up: (db) => db.exec('CREATE TABLE bench (id TEXT PRIMARY KEY, site_id TEXT NOT NULL)'),
};

describe('running migrations', () => {
  it('applies everything pending and records it', () => {
    const db = open();
    const result = runMigrations(db, [first, second]);
    expect(result.applied).toEqual(['001', '002']);
    expect(appliedMigrations(db).map((row) => row.name)).toEqual(['sites', 'benches']);
    expect(schemaVersion(db)).toBe('002');
  });

  it('is safe to run twice', () => {
    const db = open();
    runMigrations(db, [first, second]);
    const second_run = runMigrations(db, [first, second]);
    expect(second_run.applied).toEqual([]);
    expect(second_run.alreadyApplied).toBe(2);
  });

  it('applies only what is new', () => {
    const db = open();
    runMigrations(db, [first]);
    expect(runMigrations(db, [first, second]).applied).toEqual(['002']);
  });

  it('records how long each one took and when', () => {
    const db = open();
    runMigrations(db, [first], { now: () => new Date('2025-02-02T08:00:00Z') });
    const row = db.prepare('SELECT * FROM schema_migration').get();
    expect(row.applied_at).toBe('2025-02-02T08:00:00.000Z');
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('tells the logger what it did', () => {
    const seen = [];
    runMigrations(open(), [first], { logger: { info: (fields) => seen.push(fields.migration) } });
    expect(seen).toEqual(['001']);
  });

  it('rolls a failing migration back whole', () => {
    const db = open();
    const broken = {
      id: '002',
      name: 'broken',
      up: (inner) => {
        inner.exec('CREATE TABLE half (id TEXT PRIMARY KEY)');
        inner.exec('CREATE TABLE half (id TEXT PRIMARY KEY)');
      },
    };
    expect(() => runMigrations(db, [first, broken])).toThrow();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half'")
      .all();
    expect(tables).toHaveLength(0);
    expect(schemaVersion(db)).toBe('001');
  });
});

describe('drift', () => {
  it('refuses to run when an applied migration has been edited', () => {
    const db = open();
    runMigrations(db, [first]);
    const edited = { ...first, up: (inner) => inner.exec('CREATE TABLE site (id TEXT)') };
    expect(() => pendingMigrations(db, [edited])).toThrow(AppError);
    expect(() => pendingMigrations(db, [edited])).toThrow(/has changed/);
  });

  it('hashes the body of the migration, not its name', () => {
    expect(checksumOf(first)).toBe(checksumOf({ ...first, name: 'renamed' }));
    expect(checksumOf(first)).not.toBe(checksumOf(second));
  });
});

describe('ordering', () => {
  it('starts from an empty ledger', () => {
    const db = open();
    ensureMigrationTable(db);
    expect(appliedMigrations(db)).toEqual([]);
    expect(schemaVersion(db)).toBe(null);
  });

  it('applies in id order regardless of the array order', () => {
    const db = open();
    runMigrations(db, [first, second]);
    expect(appliedMigrations(db)[0].id).toBe('001');
  });
});
