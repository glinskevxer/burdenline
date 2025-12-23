import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { defineJob, runJob, runAll, findJob } from '../../src/jobs/framework.js';
import { certificateExpiryJob } from '../../src/jobs/certificate-expiry.js';
import { insertRow } from '../../src/db/repository.js';
import { fixedClock } from '../../src/lib/clock.js';
import { createMemoryLogger, silentLogger } from '../../src/lib/logger.js';

const clock = fixedClock('2026-01-05T06:00:00Z');

function context(db, logger = silentLogger()) {
  return { db, clock, logger };
}

describe('defineJob', () => {
  it('takes a name and something to run', () => {
    const job = defineJob({ name: 'x', run: async () => ({}) });
    expect(job.name).toBe('x');
    expect(job.summary).toBe('x');
  });

  it('refuses one with nothing to run', () => {
    expect(() => defineJob({ name: 'x' })).toThrow(TypeError);
    expect(() => defineJob({ run: async () => ({}) })).toThrow(TypeError);
  });
});

describe('runJob', () => {
  it('hands the job own detail back untouched', async () => {
    const job = defineJob({ name: 'detailed', run: async () => ({ examined: 1, mine: [1, 2] }) });
    expect((await runJob(job, context(null))).data.mine).toEqual([1, 2]);
  });

  it('reports what a job looked at even when it found nothing', async () => {
    const job = defineJob({ name: 'quiet', run: async () => ({ examined: 12 }) });
    const result = await runJob(job, context(null));
    expect(result).toMatchObject({ job: 'quiet', ok: true, examined: 12, found: 0, acted: 0 });
    expect(result.startedAt).toBe(clock.now());
  });

  it('records a failure rather than throwing at the caller', async () => {
    const job = defineJob({
      name: 'broken',
      run: async () => {
        throw new Error('the disk filled up');
      },
    });
    const result = await runJob(job, context(null));
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe('the disk filled up');
  });

  it('logs what it did', async () => {
    const memory = createMemoryLogger();
    await runJob(
      defineJob({ name: 'noisy', run: async () => ({ found: 3 }) }),
      context(null, memory.logger),
    );
    expect(memory.lines.some((line) => line.msg === 'job finished' && line.found === 3)).toBe(true);
  });
});

describe('runAll', () => {
  const good = defineJob({ name: 'good', run: async () => ({ examined: 1 }) });
  const bad = defineJob({
    name: 'bad',
    run: async () => {
      throw new Error('nope');
    },
  });

  it('runs every job', async () => {
    const result = await runAll([good, good], context(null));
    expect(result.ran).toBe(2);
    expect(result.ok).toBe(true);
  });

  it('carries on past one that failed', async () => {
    const result = await runAll([bad, good], context(null));
    expect(result.ran).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results[1].ok).toBe(true);
  });

  it('finds one by name', () => {
    expect(findJob([good, bad], 'bad').name).toBe('bad');
    expect(findJob([good], 'missing')).toBe(null);
  });
});

describe('the certificate sweep', () => {
  let db;

  function person(id, name, active = 1) {
    insertRow(db, 'person', {
      id,
      name,
      roles: 'shotfirer',
      active,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
  }

  function certificate(id, personId, expiresOn, extra = {}) {
    insertRow(db, 'certificate', {
      id,
      personId,
      kind: 'shotfirer',
      issuedOn: '2023-01-01',
      expiresOn,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      ...extra,
    });
  }

  beforeEach(() => {
    db = openDatabase({ database: { file: ':memory:' } });
    runMigrations(db, [core, explosives, blasting, operations]);
  });

  afterEach(() => closeDatabase(db));

  it('says so when everything is current', async () => {
    person('per_1', 'M Cronin');
    certificate('cert_1', 'per_1', '2028-01-01');
    const result = await runJob(certificateExpiryJob(), context(db));
    expect(result.found).toBe(0);
    expect(result.note).toContain('every certificate on file is current');
  });

  it('separates what has lapsed from what is about to', async () => {
    person('per_1', 'M Cronin');
    person('per_2', 'S Nolan');
    certificate('cert_1', 'per_1', '2025-12-01');
    certificate('cert_2', 'per_2', '2026-02-01');
    const result = await runJob(certificateExpiryJob(), context(db));
    expect(result.data.lapsed.map((entry) => entry.personName)).toEqual(['M Cronin']);
    expect(result.data.expiring.map((entry) => entry.personName)).toEqual(['S Nolan']);
    expect(result.found).toBe(2);
  });

  it('counts a suspended certificate as lapsed', async () => {
    person('per_1', 'M Cronin');
    certificate('cert_1', 'per_1', '2028-01-01', { suspended: 1 });
    const result = await runJob(certificateExpiryJob(), context(db));
    expect(result.data.lapsed).toHaveLength(1);
  });

  it('leaves somebody who has left the company out of it', async () => {
    person('per_1', 'Old Hand', 0);
    certificate('cert_1', 'per_1', '2025-01-01');
    const result = await runJob(certificateExpiryJob(), context(db));
    expect(result.examined).toBe(0);
    expect(result.found).toBe(0);
  });

  it('follows a longer warning window', async () => {
    person('per_1', 'M Cronin');
    certificate('cert_1', 'per_1', '2026-06-01');
    expect((await runJob(certificateExpiryJob(), context(db))).found).toBe(0);
    expect((await runJob(certificateExpiryJob({ warnWithinDays: 200 }), context(db))).found).toBe(
      1,
    );
  });
});
