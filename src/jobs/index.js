/**
 * The job table and the timer that drives it.
 *
 * The scheduler is a few lines of setInterval and that is on purpose: a quarry
 * office runs one instance of this on one machine, and a distributed job runner
 * would be more moving parts than the thing it schedules. What it does do
 * properly is refuse to start the same job twice at once, which is the failure
 * that actually happens when a sweep starts taking longer than its interval.
 */

import { runAll, findJob } from './framework.js';
import { certificateExpiryJob } from './certificate-expiry.js';
import { stockSweepJob, sleepingHolesJob } from './stock-sweep.js';

export const DEFAULT_SCHEDULE = Object.freeze({
  'certificate-expiry': 24 * 60 * 60 * 1000,
  'stock-sweep': 6 * 60 * 60 * 1000,
  'sleeping-holes': 60 * 60 * 1000,
});

export function buildJobs(options = {}) {
  return [
    certificateExpiryJob(options.certificateExpiry),
    stockSweepJob(options.stockSweep),
    sleepingHolesJob(),
  ];
}

export function jobNames(options) {
  return buildJobs(options)
    .map((job) => job.name)
    .sort();
}

export async function runNamed(name, context, options) {
  const job = findJob(buildJobs(options), name);
  if (!job) {
    return null;
  }
  return runAll([job], context);
}

export async function runEverything(context, options) {
  return runAll(buildJobs(options), context);
}

/**
 * Start the timers. Returns a handle that stops them, and the handle is what a
 * test drives rather than waiting on wall clock time.
 */
export function startScheduler(
  context,
  { schedule = DEFAULT_SCHEDULE, jobs = buildJobs(), timers = globalThis } = {},
) {
  const running = new Set();
  const handles = [];
  const history = [];

  async function fire(job) {
    if (running.has(job.name)) {
      context.logger?.warn?.({ job: job.name }, 'job is still running, skipping this turn');
      history.push({ job: job.name, skipped: true });
      return;
    }
    running.add(job.name);
    try {
      const [result] = (await runAll([job], context)).results;
      history.push(result);
    } finally {
      running.delete(job.name);
    }
  }

  for (const job of jobs) {
    const interval = schedule[job.name];
    if (!interval) {
      continue;
    }
    const handle = timers.setInterval(() => {
      fire(job);
    }, interval);
    handle.unref?.();
    handles.push(handle);
  }

  return {
    jobs: jobs.map((job) => job.name),
    history,
    isRunning(name) {
      return running.has(name);
    },
    fireNow(name) {
      const job = findJob(jobs, name);
      return job ? fire(job) : Promise.resolve();
    },
    stop() {
      for (const handle of handles) {
        timers.clearInterval(handle);
      }
      handles.length = 0;
    },
  };
}
