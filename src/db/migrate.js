/**
 * Migrations.
 *
 * Numbered, forward only, applied inside a transaction, and recorded with a hash
 * of the text that ran. The hash is the point: a migration that is edited after
 * it has been applied somewhere is the single most common way a schema drifts
 * between the office server and the site one, and this refuses to run when that
 * has happened rather than papering over it.
 */

import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { AppError } from '../lib/errors.js';
import { inTransaction } from './connection.js';

const TABLE = 'schema_migration';

export function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL
    )
  `);
}

export function appliedMigrations(db) {
  ensureMigrationTable(db);
  return db.prepare(`SELECT id, name, checksum, applied_at FROM ${TABLE} ORDER BY id`).all();
}

export function checksumOf(migration) {
  const body = typeof migration.up === 'function' ? migration.up.toString() : String(migration.sql);
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/** Load every migration module in a directory, ordered by the numeric prefix. */
export async function loadMigrations(directory = defaultDirectory()) {
  const files = readdirSync(directory)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.js$/.test(name))
    .sort();
  const migrations = [];
  for (const file of files) {
    const module = await import(pathToFileURL(join(directory, file)).href);
    const migration = module.migration ?? module.default;
    if (!migration || typeof migration.up !== 'function') {
      throw new AppError(`${file} does not export a migration`, {
        code: 'bad_migration',
        status: 500,
      });
    }
    migrations.push({ ...migration, id: migration.id ?? file.slice(0, 3), file });
  }
  assertOrdered(migrations);
  return migrations;
}

export function pendingMigrations(db, migrations) {
  const applied = new Map(appliedMigrations(db).map((row) => [row.id, row]));
  for (const migration of migrations) {
    const record = applied.get(migration.id);
    if (record && record.checksum !== checksumOf(migration)) {
      throw new AppError(
        `migration ${migration.id} has changed since it was applied on this database`,
        { code: 'migration_drift', status: 500, details: { id: migration.id } },
      );
    }
  }
  return migrations.filter((migration) => !applied.has(migration.id));
}

export function runMigrations(db, migrations, { logger = null, now = () => new Date() } = {}) {
  ensureMigrationTable(db);
  const pending = pendingMigrations(db, migrations);
  const record = db.prepare(
    `INSERT INTO ${TABLE} (id, name, checksum, applied_at, duration_ms) VALUES (?, ?, ?, ?, ?)`,
  );
  const applied = [];
  for (const migration of pending) {
    const startedAt = Date.now();
    inTransaction(db, () => {
      migration.up(db);
      record.run(
        migration.id,
        migration.name ?? migration.file ?? migration.id,
        checksumOf(migration),
        now().toISOString(),
        Date.now() - startedAt,
      );
    });
    logger?.info?.({ migration: migration.id }, 'migration applied');
    applied.push(migration.id);
  }
  return { applied, alreadyApplied: migrations.length - pending.length };
}

export async function migrateToLatest(db, options = {}) {
  const migrations = options.migrations ?? (await loadMigrations(options.directory));
  return runMigrations(db, migrations, options);
}

export function schemaVersion(db) {
  ensureMigrationTable(db);
  const row = db.prepare(`SELECT id FROM ${TABLE} ORDER BY id DESC LIMIT 1`).get();
  return row?.id ?? null;
}

function assertOrdered(migrations) {
  const seen = new Set();
  let previous = '';
  for (const migration of migrations) {
    if (seen.has(migration.id)) {
      throw new AppError(`two migrations share the id ${migration.id}`, {
        code: 'bad_migration',
        status: 500,
      });
    }
    if (migration.id <= previous) {
      throw new AppError('migrations are out of order', { code: 'bad_migration', status: 500 });
    }
    seen.add(migration.id);
    previous = migration.id;
  }
}

function defaultDirectory() {
  return join(dirname(fileURLToPath(import.meta.url)), 'migrations');
}
