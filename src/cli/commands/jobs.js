/**
 * Running a job by hand.
 *
 * The scheduler runs these on a timer inside the server, and this is the same
 * code path run from a terminal, which is what somebody does when they want to
 * know why the sweep said what it said this morning.
 */

import { buildJobs, jobNames, runNamed, runEverything } from '../../jobs/index.js';
import { EXIT, UsageError } from '../framework.js';

export function jobCommands({ db, clock, logger }) {
  const context = { db, clock, logger };

  function report(io, outcome, format) {
    if (format === 'json') {
      io.log(JSON.stringify(outcome, null, 2));
      return;
    }
    for (const result of outcome.results) {
      io.log(
        `${result.job}: ${result.ok ? 'ok' : 'failed'} examined ${result.examined} found ${result.found} in ${result.elapsedMs} ms`,
      );
      if (result.note) {
        io.log(`  ${result.note}`);
      }
      if (!result.ok) {
        io.error(`  ${result.error.message}`);
      }
    }
  }

  return {
    jobs: {
      summary: 'list the jobs that run on a timer',
      async run({ io }) {
        for (const job of buildJobs()) {
          io.log(`${job.name}  ${job.summary}`);
        }
        return EXIT.ok;
      },
    },

    'run-job': {
      summary: 'run one job, or every job, and print what it found',
      usage: '--name stock-sweep [--format json]',
      options: { name: 'the job to run, or all of them if left out', format: 'text or json' },
      async run({ options, io }) {
        if (options.name) {
          const outcome = await runNamed(options.name, context);
          if (!outcome) {
            throw new UsageError(
              `there is no job called ${options.name}, try ${jobNames().join(', ')}`,
            );
          }
          report(io, outcome, options.format);
          return outcome.ok ? EXIT.ok : EXIT.failed;
        }
        const outcome = await runEverything(context);
        report(io, outcome, options.format);
        return outcome.ok ? EXIT.ok : EXIT.failed;
      },
    },
  };
}
