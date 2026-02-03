/**
 * A migrated database for a test.
 *
 * Twenty test files were listing the migrations by hand, which meant that adding
 * one to the application meant editing twenty test files, and it had already
 * been done twice. The list lives in the application; a test asks for a
 * database and gets whatever the application would have made.
 */

import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations, loadMigrations } from '../../src/db/migrate.js';
import { insertRow } from '../../src/db/repository.js';

let cachedMigrations = null;

/** Loaded once for the whole file rather than per test, since it reads the disk. */
export async function migrations() {
  if (!cachedMigrations) {
    cachedMigrations = await loadMigrations();
  }
  return cachedMigrations;
}

export async function openTestDatabase() {
  const db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, await migrations());
  return db;
}

export function closeTestDatabase(db) {
  closeDatabase(db);
}

/** A person to hang foreign keys off. Most tests need one and care about nothing else. */
export function seedPerson(
  db,
  {
    id = 'per_1',
    name = 'M Cronin',
    roles = 'shotfirer',
    active = 1,
    at = '2026-01-01T00:00:00.000Z',
  } = {},
) {
  insertRow(db, 'person', { id, name, roles, active, createdAt: at, updatedAt: at });
  return id;
}
