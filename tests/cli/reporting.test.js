import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { migration as production } from '../../src/db/migrations/005_production.js';
import { buildCommands, commandNames } from '../../src/cli/commands/index.js';
import { run, EXIT } from '../../src/cli/framework.js';
import { seedDemoSite } from '../../src/fixtures/demo-site.js';
import { createBlast, transition } from '../../src/db/repositories/blasts.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';
import { parseCsvRecords } from '../../src/lib/csv.js';

let db;
let commands;
let seeded;
const clock = fixedClock('2025-11-03T09:00:00Z');

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
  runMigrations(db, [core, explosives, blasting, operations, production]);
  seeded = seedDemoSite(db, { clock });
  commands = buildCommands({ db, clock, logger: silentLogger() });
});

afterEach(() => closeDatabase(db));

describe('the command table', () => {
  it('lists every command once', () => {
    const names = commandNames({ db, clock, logger: silentLogger() });
    expect(names).toContain('migrate');
    expect(names).toContain('compliance');
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('drill-plan', () => {
  it('writes the plan for a pattern', async () => {
    const { io, out } = collector();
    expect(await run(commands, ['drill-plan', '--pattern', seeded.pattern.reference], io)).toBe(
      EXIT.ok,
    );
    const { records } = parseCsvRecords(out[0]);
    expect(records).toHaveLength(24);
  });

  it('writes the wider format when asked', async () => {
    const { io, out } = collector();
    await run(
      commands,
      ['drill-plan', '--pattern', seeded.pattern.reference, '--layout', 'collar_toe'],
      io,
    );
    expect(out[0]).toContain('toe_easting');
  });

  it('answers not found for a pattern that is not there', async () => {
    const { io, err } = collector();
    expect(await run(commands, ['drill-plan', '--pattern', 'nope'], io)).toBe(EXIT.notFound);
    expect(err[0]).toContain('no pattern');
  });

  it('complains when the pattern is not named', async () => {
    const { io, err } = collector();
    expect(await run(commands, ['drill-plan'], io)).toBe(EXIT.usage);
    expect(err[0]).toContain('--pattern');
  });
});

describe('blast-report', () => {
  function blast(reference = 'MDW-2025-020') {
    const created = createBlast(db, { siteId: seeded.site.id, reference }, { clock });
    transition(db, created.id, 'complete_design', {}, { clock });
    return created;
  }

  it('prints what is known about a shot', async () => {
    blast();
    const { io, out } = collector();
    expect(await run(commands, ['blast-report', '--reference', 'MDW-2025-020'], io)).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('state: designed');
    expect(out.join('\n')).toContain('events: 1');
  });

  it('writes json when asked', async () => {
    blast();
    const { io, out } = collector();
    await run(commands, ['blast-report', '--reference', 'MDW-2025-020', '--format', 'json'], io);
    expect(JSON.parse(out[0]).blast.reference).toBe('MDW-2025-020');
  });

  it('answers not found for a shot that is not there', async () => {
    const { io } = collector();
    expect(await run(commands, ['blast-report', '--reference', 'MDW-2099-001'], io)).toBe(
      EXIT.notFound,
    );
  });
});

describe('compliance', () => {
  it('reports a site with no records as compliant', async () => {
    const { io, out } = collector();
    expect(await run(commands, ['compliance', '--site', 'MDW'], io)).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('records: 0');
  });

  it('answers not found for a site code nobody uses', async () => {
    const { io } = collector();
    expect(await run(commands, ['compliance', '--site', 'ZZZ'], io)).toBe(EXIT.notFound);
  });
});

describe('daybook', () => {
  it('prints the day the stock came in', async () => {
    const { io, out } = collector();
    const code = await run(
      commands,
      ['daybook', '--magazine', seeded.magazine.id, '--date', '2025-11-03'],
      io,
    );
    expect(code).toBe(EXIT.ok);
    expect(parseCsvRecords(out[0]).records).toHaveLength(2);
  });

  it('refuses a date that is not one', async () => {
    const { io, err } = collector();
    expect(
      await run(commands, ['daybook', '--magazine', seeded.magazine.id, '--date', 'today'], io),
    ).toBe(EXIT.usage);
    expect(err[0]).toContain('calendar date');
  });

  it('answers not found for a magazine that is not there', async () => {
    const { io } = collector();
    expect(await run(commands, ['daybook', '--magazine', 'mag_missing'], io)).toBe(EXIT.notFound);
  });
});

describe('reconcile', () => {
  it('reports a shot with nothing issued as balanced', async () => {
    createBlast(db, { siteId: seeded.site.id, reference: 'MDW-2025-021' }, { clock });
    const { io, out } = collector();
    expect(await run(commands, ['reconcile', '--reference', 'MDW-2025-021'], io)).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('balanced: yes');
  });

  it('answers not found for a shot that is not there', async () => {
    const { io } = collector();
    expect(await run(commands, ['reconcile', '--reference', 'MDW-2099-001'], io)).toBe(
      EXIT.notFound,
    );
  });
});
