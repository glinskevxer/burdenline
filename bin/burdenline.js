#!/usr/bin/env node
/**
 * The command line entry point.
 *
 * It opens the database, builds the command table and exits with whatever the
 * command returned. Everything it needs is passed in, so the same command table
 * is what the tests drive.
 */

import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { createClock } from '../src/lib/clock.js';
import { openDatabase, closeDatabase } from '../src/db/connection.js';
import { run } from '../src/cli/framework.js';
import { buildCommands } from '../src/cli/commands/index.js';

async function main() {
  const config = loadConfig(process.env);
  const logger = createLogger({ ...config, logging: { level: config.logging.level } });
  const clock = createClock();
  const db = openDatabase(config, logger);
  try {
    const commands = buildCommands({ db, clock, logger, config });
    const code = await run(commands, process.argv.slice(2), console);
    process.exitCode = code;
  } finally {
    closeDatabase(db, logger);
  }
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
