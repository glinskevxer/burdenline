/**
 * The HTTP server.
 *
 * Fastify with the plugins it needs and nothing else. Everything the routes need
 * hangs off `app.deps`: the database, the clock, the services. Nothing reaches
 * for a module level singleton, which is what makes it possible to stand a whole
 * server up against an in memory database in a test and to run two of them side
 * by side.
 */

import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { errorHandler, notFoundHandler } from './plugins/errors.js';
import { createLogger } from '../lib/logger.js';
import { describeConfig } from '../config/env.js';

/** Anything that reads the database on a status route must not take it down. */
function safely(work) {
  try {
    return work();
  } catch {
    return null;
  }
}

export async function buildServer({ config, db, clock, services = {}, logger } = {}) {
  const log = logger ?? createLogger(config);
  const app = Fastify({
    loggerInstance: log,
    genReqId: () => randomUUID(),
    bodyLimit: config?.http?.bodyLimitBytes ?? 1024 * 1024,
    trustProxy: config?.http?.trustProxy ?? false,
    disableRequestLogging: true,
    ajv: {
      customOptions: {
        // Fastify strips unknown properties by default. A body carrying a field
        // nobody defined is nearly always a caller working from an out of date
        // idea of the api, and silently dropping it hides that until something
        // downstream is missing a value.
        removeAdditional: false,
        allErrors: true,
        coerceTypes: false,
      },
    },
  });

  app.decorate('deps', { config, db, clock, services, logger: log });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: false });

  app.setErrorHandler(errorHandler(log));
  app.setNotFoundHandler(notFoundHandler());

  app.addHook('onRequest', async (request) => {
    request.startedAt = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (request, reply) => {
    const elapsedMs = Number(process.hrtime.bigint() - request.startedAt) / 1e6;
    log.info(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        elapsedMs: Math.round(elapsedMs * 100) / 100,
      },
      'request',
    );
  });

  const startedAt = clock?.now?.() ?? new Date().toISOString();

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (request, reply) => {
    try {
      db.prepare('SELECT 1 AS ok').get();
      return { status: 'ready', database: 'ok' };
    } catch (error) {
      log.error({ err: error }, 'readiness check failed');
      return reply.code(503).send({
        type: 'https://burdenline.invalid/problems/not_ready',
        title: 'not ready',
        status: 503,
        detail: 'the database is not answering',
        requestId: request.id,
      });
    }
  });

  /**
   * What this build is and what state it is in. Read by whoever is standing in
   * front of a machine in a quarry office trying to work out whether it is the
   * one that was deployed, and by the deploy check afterwards.
   */
  app.get('/about', async () => {
    const schema = safely(() => db.prepare('SELECT max(id) AS id FROM schema_migration').get()?.id);
    const counts = {};
    for (const table of ['site', 'blast', 'monitor_record', 'magazine_ledger', 'complaint']) {
      counts[table] =
        safely(() => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n) ?? null;
    }
    return {
      service: 'burdenline',
      startedAt,
      uptimeSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
      node: process.version,
      schemaVersion: schema ?? null,
      counts,
      config: describeConfig(config),
    };
  });

  return app;
}
