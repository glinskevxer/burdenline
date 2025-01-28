/**
 * The SQLite connection.
 *
 * One quarry, one server, one file. SQLite is the right size for this and it
 * makes the day-book durable without an operations team, but it has to be opened
 * carefully: foreign keys are off by default, the default busy timeout is zero,
 * and the default journal mode blocks a reader for the whole of a write.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { AppError } from '../lib/errors.js';

export function openDatabase(config, logger = null) {
  const file = config?.database?.file ?? ':memory:';
  const inMemory = file === ':memory:';
  if (!inMemory) {
    mkdirSync(dirname(file), { recursive: true });
  }

  let db;
  try {
    db = new Database(file);
  } catch (cause) {
    throw new AppError(`could not open the database at ${file}`, {
      code: 'database_unavailable',
      status: 503,
      cause,
    });
  }

  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${config?.database?.busyTimeoutMs ?? 5000}`);
  if (!inMemory && (config?.database?.walMode ?? true)) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -16000');

  logger?.debug?.({ file, walMode: db.pragma('journal_mode', { simple: true }) }, 'database open');
  return db;
}

/** Read a pragma back, which is the only way to know an option actually took. */
export function pragmaSnapshot(db) {
  return {
    foreignKeys: db.pragma('foreign_keys', { simple: true }) === 1,
    journalMode: String(db.pragma('journal_mode', { simple: true })).toLowerCase(),
    busyTimeout: db.pragma('busy_timeout', { simple: true }),
    tempStore: db.pragma('temp_store', { simple: true }),
  };
}

/**
 * Run work in a transaction. better-sqlite3 transactions are synchronous by
 * design, which suits us: every write in this system is a short burst of
 * statements and nothing awaits inside one.
 */
export function inTransaction(db, work) {
  if (typeof work !== 'function') {
    throw new TypeError('a transaction needs a function to run');
  }
  const wrapped = db.transaction(work);
  return wrapped();
}

/** Nested calls join the outer transaction rather than opening a second one. */
export function inSavepoint(db, work) {
  if (!db.inTransaction) {
    return inTransaction(db, work);
  }
  const name = `sp_${Math.floor(Math.random() * 1e9).toString(36)}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = work();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  }
}

export function closeDatabase(db, logger = null) {
  if (!db || !db.open) {
    return;
  }
  try {
    if (String(db.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal') {
      db.pragma('wal_checkpoint(TRUNCATE)');
    }
  } catch (error) {
    logger?.warn?.({ err: error }, 'checkpoint before close failed');
  }
  db.close();
}

export function integrityCheck(db) {
  const rows = db.pragma('integrity_check');
  const first = rows[0]?.integrity_check ?? rows[0];
  return { ok: first === 'ok', report: rows.map((row) => row.integrity_check ?? row) };
}
