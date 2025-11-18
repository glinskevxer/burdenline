import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { databaseCommands } from '../../src/cli/commands/database.js';
import { run, EXIT } from '../../src/cli/framework.js';
import { fixedClock } from '../../src/lib/clock.js';
import { countWhere } from '../../src/db/repository.js';

let db;
let commands;
const clock = fixedClock('2025-10-28T09:00:00Z');

function collector() {
  const out = [];
  const err = [];
  return {
    io: { log: (line) => out.push(String(line)), error: (line) => err.push(String(line)) },
    out,
    err,
  };
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  commands = databaseCommands({ db, clock });
});

afterEach(() => closeDatabase(db));

describe('migrate', () => {
  it('applies everything on an empty database', async () => {
    const { io, out } = collector();
    expect(await run(commands, ['migrate'], io)).toBe(EXIT.ok);
    expect(out[0]).toContain('applied 001, 002, 003, 004');
  });

  it('says there is nothing to do the second time', async () => {
    const { io, out } = collector();
    await run(commands, ['migrate'], io);
    await run(commands, ['migrate'], io);
    expect(out[1]).toContain('nothing to do');
  });

  it('changes nothing on a dry run', async () => {
    const { io, out } = collector();
    expect(await run(commands, ['migrate', '--dry-run'], io)).toBe(EXIT.ok);
    expect(out[0]).toContain('none');
    expect(countWhere(db, 'schema_migration')).toBe(0);
  });
});

describe('status', () => {
  it('reports the version and the row counts', async () => {
    runMigrations(db, [core, explosives, blasting, operations]);
    const { io, out } = collector();
    expect(await run(commands, ['status'], io)).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('schema version: 004');
    expect(out.join('\n')).toContain('integrity: ok');
    expect(out.join('\n')).toContain('site: 0');
  });

  it('says the schema is at nothing before any migration', async () => {
    const { io, out } = collector();
    await run(commands, ['status'], io);
    expect(out[0]).toContain('none');
  });
});

describe('seed', () => {
  beforeEach(() => {
    runMigrations(db, [core, explosives, blasting, operations]);
  });

  it('loads a whole quarry', async () => {
    const { io, out } = collector();
    expect(await run(commands, ['seed'], io)).toBe(EXIT.ok);
    expect(out[0]).toContain('seeded MDW');
    expect(countWhere(db, 'site')).toBe(1);
    expect(countWhere(db, 'hole')).toBe(24);
    expect(countWhere(db, 'receptor')).toBe(4);
    expect(countWhere(db, 'magazine_ledger')).toBe(2);
  });

  it('takes a site code', async () => {
    const { io } = collector();
    await run(commands, ['seed', '--code', 'RCK'], io);
    expect(db.prepare('SELECT code FROM site').get().code).toBe('RCK');
  });

  it('refuses a code that is not one', async () => {
    const { io, err } = collector();
    expect(await run(commands, ['seed', '--code', 'midway'], io)).toBe(EXIT.usage);
    expect(err[0]).toContain('two to four capital letters');
  });

  it('refuses to seed over an existing site', async () => {
    const { io, err } = collector();
    await run(commands, ['seed'], io);
    expect(await run(commands, ['seed', '--code', 'RCK'], io)).toBe(EXIT.refused);
    expect(err[0]).toContain('--force');
  });

  it('seeds anyway when forced, without colliding with the first quarry', async () => {
    const { io } = collector();
    await run(commands, ['seed'], io);
    expect(await run(commands, ['seed', '--code', 'RCK', '--force'], io)).toBe(EXIT.ok);
    expect(countWhere(db, 'site')).toBe(2);
    expect(countWhere(db, 'person')).toBe(8);
  });

  it('drills the holes it laid out, with a wet one in there', async () => {
    const { io } = collector();
    await run(commands, ['seed'], io);
    const drilled = db
      .prepare('SELECT count(*) AS n FROM hole WHERE drilled_depth_m IS NOT NULL')
      .get();
    expect(drilled.n).toBe(24);
    expect(
      db.prepare("SELECT count(*) AS n FROM hole WHERE condition = 'wet'").get().n,
    ).toBeGreaterThan(0);
  });

  it('leaves a site law behind to design against', async () => {
    const { io } = collector();
    await run(commands, ['seed'], io);
    expect(db.prepare('SELECT k FROM site_law').get().k).toBe(1140);
  });
});
