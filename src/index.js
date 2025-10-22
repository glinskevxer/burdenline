/**
 * The process.
 *
 * Everything interesting is somewhere else. This reads the environment, opens
 * the database, applies whatever migrations are outstanding, starts the server,
 * and then does the one thing a long running process has to get right: shuts
 * down in an order that does not lose a write. The listener stops first so no
 * new request arrives, then in flight requests are given a few seconds, then the
 * database is checkpointed and closed.
 */

import { loadConfig } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createClock } from './lib/clock.js';
import { openDatabase, closeDatabase } from './db/connection.js';
import { migrateToLatest } from './db/migrate.js';
import { buildApp } from './http/app.js';

const SHUTDOWN_GRACE_MS = 10000;

export async function bootstrap({ env = process.env, migrate = true } = {}) {
  const config = loadConfig(env);
  const logger = createLogger(config);
  for (const warning of config.warnings) {
    logger.warn({ warning }, 'configuration warning');
  }
  const clock = createClock();
  const db = openDatabase(config, logger);
  if (migrate) {
    const result = await migrateToLatest(db, { logger });
    logger.info(
      { applied: result.applied, alreadyApplied: result.alreadyApplied },
      'database migrated',
    );
  }
  const app = await buildApp({ config, db, clock, logger });
  return { app, db, config, logger, clock };
}

export async function main({ env = process.env } = {}) {
  const { app, db, config, logger } = await bootstrap({ env });
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      logger.error({ signal }, 'shutdown took too long, exiting anyway');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    timer.unref?.();
    try {
      await app.close();
      closeDatabase(db, logger);
      logger.info('shut down cleanly');
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shutdown(signal);
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection');
    shutdown('unhandledRejection');
  });

  await app.listen({ host: config.http.host, port: config.http.port });
  logger.info({ host: config.http.host, port: config.http.port }, 'listening');
  return { app, db, shutdown };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
