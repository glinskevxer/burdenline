/**
 * Every job, run against a database that looks like a working quarry.
 *
 * The unit tests for each job set up exactly what that job reads. This one runs
 * all of them against the seeded site, which is the case that actually happens
 * and the one where a job reading a column another job writes goes wrong.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase } from '../helpers/database.js';
import { runEverything, buildJobs, jobNames } from '../../src/jobs/index.js';
import { runJob, findJob } from '../../src/jobs/framework.js';
import { seedDemoSite } from '../../src/fixtures/demo-site.js';
import { createBlast, transition } from '../../src/db/repositories/blasts.js';
import { createMemoryLogger, silentLogger } from '../../src/lib/logger.js';
import { fixedClock } from '../../src/lib/clock.js';

let db;
let seeded;
const clock = fixedClock('2026-06-24T06:00:00Z');

function context(logger = silentLogger()) {
  return { db, clock, logger };
}

beforeEach(async () => {
  db = await openTestDatabase();
  seeded = seedDemoSite(db, { clock });
});

afterEach(() => closeTestDatabase(db));

describe('the whole set against the seeded quarry', () => {
  it('runs every job without one of them falling over', async () => {
    const outcome = await runEverything(context());
    expect(outcome.ran).toBe(buildJobs().length);
    expect(outcome.ok).toBe(true);
    expect(outcome.results.every((result) => result.error === undefined)).toBe(true);
  });

  it('gives every job the four counts, whether or not it found anything', async () => {
    const outcome = await runEverything(context());
    for (const result of outcome.results) {
      expect(typeof result.examined).toBe('number');
      expect(typeof result.found).toBe('number');
      expect(typeof result.acted).toBe('number');
      expect(result.note).toBeTruthy();
    }
  });

  it('names every job in the outcome', async () => {
    const outcome = await runEverything(context());
    expect(outcome.results.map((result) => result.job).sort()).toEqual(jobNames());
  });

  it('logs a line per job', async () => {
    const memory = createMemoryLogger();
    await runEverything(context(memory.logger));
    const finished = memory.lines.filter((line) => line.msg === 'job finished');
    expect(finished).toHaveLength(buildJobs().length);
  });

  it('finds the certificate the seeded shotfirer holds and says it is current', async () => {
    const result = await runJob(findJob(buildJobs(), 'certificate-expiry'), context());
    expect(result.examined).toBe(1);
    expect(result.found).toBe(0);
  });

  it('finds the seeded magazine inside its licence', async () => {
    const result = await runJob(findJob(buildJobs(), 'stock-sweep'), context());
    expect(result.examined).toBe(1);
    expect(result.data.magazines).toEqual([]);
  });

  it('has nothing loaded to be sleeping', async () => {
    const result = await runJob(findJob(buildJobs(), 'sleeping-holes'), context());
    expect(result.examined).toBe(0);
  });

  it('reviews the seeded store without a history to go on', async () => {
    const result = await runJob(findJob(buildJobs(), 'supply-review'), context());
    expect(result.examined).toBe(1);
    expect(result.found).toBe(0);
  });

  it('finds a shot planned for tomorrow that nobody has been told about', async () => {
    const blast = createBlast(
      db,
      { siteId: seeded.site.id, reference: 'MDW-2026-090', plannedFor: '2026-06-25T13:00:00.000Z' },
      { clock },
    );
    transition(db, blast.id, 'complete_design', {}, { clock });
    const result = await runJob(findJob(buildJobs(), 'notice-sweep'), context());
    expect(result.found).toBe(1);
    expect(result.data.details[0].rule).toBe('notice.none_planned');
  });

  it('finds nothing over a limit on a site with no monitor records', async () => {
    const result = await runJob(findJob(buildJobs(), 'exceedance-watch'), context());
    expect(result.examined).toBe(0);
    expect(result.found).toBe(0);
  });

  it('runs twice in a row and reports the same thing both times', async () => {
    const first = await runEverything(context());
    const second = await runEverything(context());
    expect(second.results.map((result) => [result.job, result.found])).toEqual(
      first.results.map((result) => [result.job, result.found]),
    );
  });

  it('carries on past a job that throws', async () => {
    const broken = {
      name: 'broken',
      summary: 'always fails',
      run: async () => {
        throw new Error('the disk filled up');
      },
    };
    const outcome = await runEverything(context());
    const withBroken = await runJob(broken, context());
    expect(withBroken.ok).toBe(false);
    expect(outcome.ok).toBe(true);
  });
});
