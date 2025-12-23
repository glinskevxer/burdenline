/**
 * Jobs that run on a timer.
 *
 * Every one of them answers the same shape: what it looked at, what it found,
 * and what it did about it. That matters because these run at six in the morning
 * with nobody watching, and the only evidence that a job ran and found nothing is
 * a record saying so. A job that returns nothing looks exactly like a job that
 * never ran.
 *
 * Jobs never throw at the caller. A job that fails records the failure and lets
 * the others run, because a certificate sweep falling over should not stop the
 * stock reconciliation.
 */

import { roundTo } from '../lib/units.js';

export function defineJob({ name, summary, run }) {
  if (!name || typeof run !== 'function') {
    throw new TypeError('a job needs a name and something to run');
  }
  return { name, summary: summary ?? name, run };
}

export async function runJob(job, context) {
  const startedAt = context.clock.now();
  const started = Date.now();
  try {
    const result = await job.run(context);
    const outcome = {
      job: job.name,
      ok: true,
      startedAt,
      elapsedMs: Date.now() - started,
      examined: result?.examined ?? 0,
      found: result?.found ?? 0,
      acted: result?.acted ?? 0,
      details: result?.details ?? [],
      note: result?.note ?? null,
      // Whatever else the job wants to hand back. The four counts above are the
      // shape every job shares; this is the part only that job knows about.
      data: result ?? {},
    };
    context.logger?.info?.(
      { job: job.name, examined: outcome.examined, found: outcome.found, acted: outcome.acted },
      'job finished',
    );
    return outcome;
  } catch (error) {
    context.logger?.error?.({ job: job.name, err: error }, 'job failed');
    return {
      job: job.name,
      ok: false,
      startedAt,
      elapsedMs: Date.now() - started,
      examined: 0,
      found: 0,
      acted: 0,
      details: [],
      data: {},
      error: { message: error.message, code: error.code ?? null },
    };
  }
}

/** Run a set of jobs one after another and report on all of them. */
export async function runAll(jobs, context) {
  const results = [];
  for (const job of jobs) {
    results.push(await runJob(job, context));
  }
  const failed = results.filter((result) => !result.ok);
  return {
    ran: results.length,
    failed: failed.length,
    ok: failed.length === 0,
    results,
    totalElapsedMs: roundTo(
      results.reduce((sum, result) => sum + result.elapsedMs, 0),
      0,
    ),
  };
}

export function findJob(jobs, name) {
  return jobs.find((job) => job.name === name) ?? null;
}
