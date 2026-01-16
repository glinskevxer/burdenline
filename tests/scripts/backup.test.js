import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { migration as production } from '../../src/db/migrations/005_production.js';
import { seedDemoSite } from '../../src/fixtures/demo-site.js';
import { fixedClock } from '../../src/lib/clock.js';

const directories = [];

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'burdenline-backup-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop(), { recursive: true, force: true });
  }
});

function seededDatabase(directory) {
  const file = join(directory, 'site.db');
  const db = openDatabase({ database: { file, walMode: true } });
  runMigrations(db, [core, explosives, blasting, operations, production]);
  seedDemoSite(db, { clock: fixedClock('2025-11-10T09:00:00Z') });
  closeDatabase(db);
  return file;
}

describe('the backup script', () => {
  it('writes a copy that opens and has the data in it', () => {
    const directory = workspace();
    const file = seededDatabase(directory);
    const out = join(directory, 'backups');
    execFileSync('node', ['scripts/backup.js', '--db', file, '--out', out], { encoding: 'utf8' });
    const [copy] = readdirSync(out);
    expect(copy).toMatch(/^burdenline-.*\.db$/);
    const restored = new Database(join(out, copy), { readonly: true });
    expect(restored.prepare('SELECT count(*) AS n FROM hole').get().n).toBe(24);
    restored.close();
  });

  it('leaves no partial file behind', () => {
    const directory = workspace();
    const file = seededDatabase(directory);
    const out = join(directory, 'backups');
    execFileSync('node', ['scripts/backup.js', '--db', file, '--out', out]);
    expect(readdirSync(out).filter((name) => name.endsWith('.partial'))).toHaveLength(0);
  });

  it('fails rather than writing a copy of a database that is not there', () => {
    const directory = workspace();
    expect(() =>
      execFileSync(
        'node',
        ['scripts/backup.js', '--db', join(directory, 'nothing.db'), '--out', directory],
        {
          stdio: 'pipe',
        },
      ),
    ).toThrow();
  });
});
