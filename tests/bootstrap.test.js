import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap } from '../src/index.js';
import { closeDatabase } from '../src/db/connection.js';
import { schemaVersion } from '../src/db/migrate.js';

const opened = [];
const directories = [];

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'burdenline-boot-'));
  directories.push(directory);
  return join(directory, 'site.db');
}

afterEach(async () => {
  while (opened.length) {
    const { app, db } = opened.pop();
    await app.close();
    closeDatabase(db);
  }
  while (directories.length) {
    rmSync(directories.pop(), { recursive: true, force: true });
  }
});

async function boot(env = {}) {
  const started = await bootstrap({
    env: {
      NODE_ENV: 'test',
      BURDENLINE_JWT_SECRET: 'e'.repeat(40),
      BURDENLINE_DB: temporaryDatabase(),
      BURDENLINE_LOG_LEVEL: 'silent',
      ...env,
    },
  });
  opened.push(started);
  return started;
}

describe('bootstrap', () => {
  it('opens the database and applies every migration', async () => {
    const { db } = await boot();
    expect(schemaVersion(db)).toBe('007');
  });

  it('creates the tables the application needs', async () => {
    const { db } = await boot();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).toContain('blast');
    expect(tables).toContain('magazine_ledger');
    expect(tables).toContain('monitor_record');
  });

  it('answers on the health route without listening on a socket', async () => {
    const { app } = await boot();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  it('carries the config it read into the app', async () => {
    const { app, config } = await boot({ BURDENLINE_SITE_ZONE: 'Europe/Dublin' });
    expect(config.site.zone).toBe('Europe/Dublin');
    expect(app.deps.config.site.zone).toBe('Europe/Dublin');
  });

  it('can be told not to migrate', async () => {
    const { db } = await boot();
    const second = await bootstrap({
      env: {
        NODE_ENV: 'test',
        BURDENLINE_JWT_SECRET: 'e'.repeat(40),
        BURDENLINE_DB: ':memory:',
        BURDENLINE_LOG_LEVEL: 'silent',
      },
      migrate: false,
    });
    opened.push(second);
    expect(schemaVersion(second.db)).toBe(null);
    expect(schemaVersion(db)).toBe('007');
  });

  it('refuses to boot on a broken environment', async () => {
    await expect(boot({ BURDENLINE_PORT: '70000' })).rejects.toThrow(/environment/);
  });

  it('refuses to boot production with no signing secret', async () => {
    await expect(
      bootstrap({
        env: { NODE_ENV: 'production', BURDENLINE_DB: temporaryDatabase() },
      }),
    ).rejects.toThrow(/environment/);
  });

  it('applies nothing the second time it opens the same file', async () => {
    const file = temporaryDatabase();
    const env = {
      NODE_ENV: 'test',
      BURDENLINE_JWT_SECRET: 'e'.repeat(40),
      BURDENLINE_DB: file,
      BURDENLINE_LOG_LEVEL: 'silent',
    };
    const first = await bootstrap({ env });
    opened.push(first);
    const second = await bootstrap({ env });
    opened.push(second);
    expect(schemaVersion(second.db)).toBe('007');
    expect(second.db.prepare('SELECT count(*) AS n FROM schema_migration').get().n).toBe(7);
  });
});

describe('a booted process', () => {
  it('is ready straight away, because it migrated on the way up', async () => {
    const { app } = await boot();
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json().pendingMigrations).toBe(0);
  });

  it('says which schema it is at on the about route', async () => {
    const { app, db } = await boot();
    const response = await app.inject({ method: 'GET', url: '/about' });
    expect(response.json().schemaVersion).toBe(schemaVersion(db));
  });

  it('is not ready when it was told not to migrate', async () => {
    const started = await bootstrap({
      env: {
        NODE_ENV: 'test',
        BURDENLINE_JWT_SECRET: 'e'.repeat(40),
        BURDENLINE_DB: ':memory:',
        BURDENLINE_LOG_LEVEL: 'silent',
      },
      migrate: false,
    });
    opened.push(started);
    const response = await started.app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
  });

  it('carries the counts of an empty quarry on the about route', async () => {
    const { app } = await boot();
    expect((await app.inject({ method: 'GET', url: '/about' })).json().counts.site).toBe(0);
  });
});
