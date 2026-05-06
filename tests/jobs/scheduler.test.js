import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase } from '../helpers/database.js';
import {
  buildJobs,
  jobNames,
  runNamed,
  runEverything,
  startScheduler,
  DEFAULT_SCHEDULE,
} from '../../src/jobs/index.js';
import { defineJob } from '../../src/jobs/framework.js';
import { buildCommands } from '../../src/cli/commands/index.js';
import { run, EXIT } from '../../src/cli/framework.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger, createMemoryLogger } from '../../src/lib/logger.js';

let db;
const clock = fixedClock('2026-01-12T06:00:00Z');

function context(logger = silentLogger()) {
  return { db, clock, logger };
}

function collector() {
  const out = [];
  const err = [];
  return {
    io: { log: (line) => out.push(String(line)), error: (line) => err.push(String(line)) },
    out,
    err,
  };
}

/** A fake timer table so the scheduler can be driven rather than waited on. */
function fakeTimers() {
  const registered = [];
  return {
    setInterval(fn, interval) {
      const handle = { fn, interval, cleared: false };
      registered.push(handle);
      return handle;
    },
    clearInterval(handle) {
      handle.cleared = true;
    },
    registered,
  };
}

beforeEach(async () => {
  db = await openTestDatabase();
});

afterEach(() => closeTestDatabase(db));

describe('the job table', () => {
  it('carries the three sweeps', () => {
    expect(jobNames()).toEqual([
      'certificate-expiry',
      'exceedance-watch',
      'notice-sweep',
      'sleeping-holes',
      'stock-sweep',
      'supply-review',
    ]);
  });

  it('gives every job an interval', () => {
    for (const job of buildJobs()) {
      expect(DEFAULT_SCHEDULE[job.name]).toBeGreaterThan(0);
    }
  });

  it('runs one by name', async () => {
    const outcome = await runNamed('certificate-expiry', context());
    expect(outcome.ran).toBe(1);
    expect(outcome.ok).toBe(true);
  });

  it('has nothing to run for a name nobody defined', async () => {
    expect(await runNamed('polish-the-brass', context())).toBe(null);
  });

  it('runs the lot', async () => {
    const outcome = await runEverything(context());
    expect(outcome.ran).toBe(6);
    expect(outcome.ok).toBe(true);
  });
});

describe('the scheduler', () => {
  it('registers a timer per job', () => {
    const timers = fakeTimers();
    const scheduler = startScheduler(context(), { timers });
    expect(timers.registered).toHaveLength(6);
    scheduler.stop();
    expect(timers.registered.every((handle) => handle.cleared)).toBe(true);
  });

  it('leaves out a job with no interval', () => {
    const timers = fakeTimers();
    startScheduler(context(), { timers, schedule: { 'stock-sweep': 1000 } });
    expect(timers.registered).toHaveLength(1);
  });

  it('runs a job when its timer fires', async () => {
    const timers = fakeTimers();
    const scheduler = startScheduler(context(), { timers });
    await timers.registered[0].fn();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(scheduler.history.length).toBeGreaterThan(0);
    scheduler.stop();
  });

  it('skips a turn rather than starting the same job twice', async () => {
    let release;
    const slow = defineJob({
      name: 'slow',
      run: () =>
        new Promise((resolve) => {
          release = () => resolve({ examined: 1 });
        }),
    });
    const memory = createMemoryLogger();
    const timers = fakeTimers();
    const scheduler = startScheduler(context(memory.logger), {
      timers,
      jobs: [slow],
      schedule: { slow: 1000 },
    });
    const first = scheduler.fireNow('slow');
    await scheduler.fireNow('slow');
    expect(scheduler.history.some((entry) => entry.skipped)).toBe(true);
    release();
    await first;
    scheduler.stop();
  });

  it('does nothing when told to fire a job it does not have', async () => {
    const scheduler = startScheduler(context(), { timers: fakeTimers(), jobs: [] });
    await expect(scheduler.fireNow('missing')).resolves.toBeUndefined();
  });
});

describe('the job commands', () => {
  it('lists the jobs', async () => {
    const { io, out } = collector();
    const commands = buildCommands({ db, clock, logger: silentLogger() });
    expect(await run(commands, ['jobs'], io)).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('stock-sweep');
  });

  it('runs one and prints what it found', async () => {
    const { io, out } = collector();
    const commands = buildCommands({ db, clock, logger: silentLogger() });
    expect(await run(commands, ['run-job', '--name', 'stock-sweep'], io)).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('stock-sweep: ok');
  });

  it('runs the lot when no name is given', async () => {
    const { io, out } = collector();
    const commands = buildCommands({ db, clock, logger: silentLogger() });
    await run(commands, ['run-job'], io);
    expect(out.filter((line) => line.includes(': ok'))).toHaveLength(6);
  });

  it('writes json when asked', async () => {
    const { io, out } = collector();
    const commands = buildCommands({ db, clock, logger: silentLogger() });
    await run(commands, ['run-job', '--name', 'sleeping-holes', '--format', 'json'], io);
    expect(JSON.parse(out[0]).results[0].job).toBe('sleeping-holes');
  });

  it('complains about a job nobody defined', async () => {
    const { io, err } = collector();
    const commands = buildCommands({ db, clock, logger: silentLogger() });
    expect(await run(commands, ['run-job', '--name', 'polish'], io)).toBe(EXIT.usage);
    expect(err[0]).toContain('no job called polish');
  });
});
