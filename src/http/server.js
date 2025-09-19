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

  app.get('/about', async () => ({
    service: 'burdenline',
    config: describeConfig(config),
  }));

  return app;
}

export async function startServer(options) {
  const app = await buildServer(options);
  const { host, port } = options.config.http;
  await app.listen({ host, port });
  return app;
}
