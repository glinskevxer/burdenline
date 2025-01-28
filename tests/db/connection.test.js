import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  pragmaSnapshot,
  inTransaction,
  inSavepoint,
  closeDatabase,
  integrityCheck,
} from '../../src/db/connection.js';

const opened = [];
const temporaryDirectories = [];

function open(overrides = {}) {
  const db = openDatabase({ database: { file: ':memory:', ...overrides } });
  opened.push(db);
  return db;
}

function temporaryFile() {
  const directory = mkdtempSync(join(tmpdir(), 'burdenline-'));
  temporaryDirectories.push(directory);
  return join(directory, 'nested', 'site.db');
}

afterEach(() => {
  while (opened.length) {
    closeDatabase(opened.pop());
  }
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('openDatabase', () => {
  it('turns foreign keys on, which sqlite does not do by itself', () => {
    expect(pragmaSnapshot(open()).foreignKeys).toBe(true);
  });

  it('sets a busy timeout so a second writer waits instead of failing', () => {
    expect(pragmaSnapshot(open({ busyTimeoutMs: 3000 })).busyTimeout).toBe(3000);
  });

  it('leaves an in memory database on the default journal', () => {
    expect(pragmaSnapshot(open()).journalMode).toBe('memory');
  });

  it('creates the directory of a file database', () => {
    const file = temporaryFile();
    const db = openDatabase({ database: { file, walMode: true } });
    opened.push(db);
    expect(existsSync(file)).toBe(true);
    expect(pragmaSnapshot(db).journalMode).toBe('wal');
  });

  it('honours a request to stay off the write ahead log', () => {
    const db = openDatabase({ database: { file: temporaryFile(), walMode: false } });
    opened.push(db);
    expect(pragmaSnapshot(db).journalMode).not.toBe('wal');
  });

  it('logs the file it opened', () => {
    const seen = [];
    open();
    openDatabase({ database: { file: ':memory:' } }, { debug: (fields) => seen.push(fields) });
    expect(seen[0].file).toBe(':memory:');
  });
});

describe('transactions', () => {
  function seeded() {
    const db = open();
    db.exec('CREATE TABLE hole (id TEXT PRIMARY KEY, depth REAL NOT NULL)');
    return db;
  }

  it('commits the whole unit', () => {
    const db = seeded();
    inTransaction(db, () => {
      db.prepare('INSERT INTO hole VALUES (?, ?)').run('h1', 12);
      db.prepare('INSERT INTO hole VALUES (?, ?)').run('h2', 12.5);
    });
    expect(db.prepare('SELECT count(*) AS n FROM hole').get().n).toBe(2);
  });

  it('rolls the whole unit back', () => {
    const db = seeded();
    expect(() =>
      inTransaction(db, () => {
        db.prepare('INSERT INTO hole VALUES (?, ?)').run('h1', 12);
        throw new Error('survey came back wrong');
      }),
    ).toThrow('survey came back wrong');
    expect(db.prepare('SELECT count(*) AS n FROM hole').get().n).toBe(0);
  });

  it('hands the return value back', () => {
    const db = seeded();
    expect(inTransaction(db, () => 'done')).toBe('done');
  });

  it('refuses anything that is not a function', () => {
    expect(() => inTransaction(seeded(), 'INSERT')).toThrow(TypeError);
  });
});

describe('savepoints', () => {
  function seeded() {
    const db = open();
    db.exec('CREATE TABLE hole (id TEXT PRIMARY KEY, depth REAL NOT NULL)');
    return db;
  }

  it('opens a transaction of its own when there is none', () => {
    const db = seeded();
    inSavepoint(db, () => db.prepare('INSERT INTO hole VALUES (?, ?)').run('h1', 9));
    expect(db.prepare('SELECT count(*) AS n FROM hole').get().n).toBe(1);
  });

  it('rolls back only the inner work', () => {
    const db = seeded();
    inTransaction(db, () => {
      db.prepare('INSERT INTO hole VALUES (?, ?)').run('outer', 10);
      try {
        inSavepoint(db, () => {
          db.prepare('INSERT INTO hole VALUES (?, ?)').run('inner', 11);
          throw new Error('hole collapsed');
        });
      } catch {
        // the outer unit carries on without the inner hole
      }
    });
    const ids = db
      .prepare('SELECT id FROM hole ORDER BY id')
      .all()
      .map((row) => row.id);
    expect(ids).toEqual(['outer']);
  });
});

describe('shutdown and health', () => {
  it('reports a healthy file', () => {
    expect(integrityCheck(open()).ok).toBe(true);
  });

  it('closes once and tolerates being asked twice', () => {
    const db = openDatabase({ database: { file: ':memory:' } });
    closeDatabase(db);
    expect(db.open).toBe(false);
    expect(() => closeDatabase(db)).not.toThrow();
    expect(() => closeDatabase(null)).not.toThrow();
  });
});
