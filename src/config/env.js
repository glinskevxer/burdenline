/**
 * Configuration.
 *
 * Every setting the process needs is read here once, validated, and handed out
 * frozen. Reading `process.env` anywhere else is a lint level mistake in review:
 * it hides a required setting from the startup check and turns a missing value
 * into a runtime failure at four in the morning rather than a refusal to boot.
 */

import { z } from 'zod';
import { ValidationError } from '../lib/errors.js';

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) => value === true || value === 'true' || value === '1' || value === 'yes');

const port = z.coerce.number().int().min(1).max(65535);

export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BURDENLINE_HOST: z.string().min(1).default('127.0.0.1'),
  BURDENLINE_PORT: port.default(8080),
  BURDENLINE_DB: z.string().min(1).default('data/burdenline.db'),
  BURDENLINE_DB_WAL: booleanish.default(true),
  BURDENLINE_DB_BUSY_TIMEOUT_MS: z.coerce.number().int().min(0).max(60000).default(5000),
  BURDENLINE_LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
  BURDENLINE_JWT_SECRET: z.string().min(32).optional(),
  BURDENLINE_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(480),
  BURDENLINE_SITE_ZONE: z.string().min(1).default('Europe/Dublin'),
  BURDENLINE_REQUEST_BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(1024 * 1024),
  BURDENLINE_TRUST_PROXY: booleanish.default(false),
});

/**
 * Production refuses to start without a signing secret. Development invents one
 * so a fresh clone runs, and says so, because a secret nobody chose must never
 * survive into a deployment.
 */
export function loadConfig(source = process.env) {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the environment is not usable');
  }
  const values = parsed.data;
  const warnings = [];
  let jwtSecret = values.BURDENLINE_JWT_SECRET;
  if (!jwtSecret) {
    if (values.NODE_ENV === 'production') {
      throw new ValidationError('the environment is not usable', [
        {
          path: 'BURDENLINE_JWT_SECRET',
          message: 'a signing secret of at least 32 characters is required in production',
          kind: 'missing',
        },
      ]);
    }
    jwtSecret = 'development-only-signing-secret-not-for-deployment';
    warnings.push('BURDENLINE_JWT_SECRET is unset, using the development secret');
  }
  if (values.NODE_ENV === 'production' && values.BURDENLINE_DB === ':memory:') {
    throw new ValidationError('the environment is not usable', [
      {
        path: 'BURDENLINE_DB',
        message: 'an in memory database cannot be used in production',
        kind: 'unsupported',
      },
    ]);
  }

  return Object.freeze({
    env: values.NODE_ENV,
    isProduction: values.NODE_ENV === 'production',
    isTest: values.NODE_ENV === 'test',
    http: Object.freeze({
      host: values.BURDENLINE_HOST,
      port: values.BURDENLINE_PORT,
      bodyLimitBytes: values.BURDENLINE_REQUEST_BODY_LIMIT_BYTES,
      trustProxy: values.BURDENLINE_TRUST_PROXY,
    }),
    database: Object.freeze({
      file: values.BURDENLINE_DB,
      walMode: values.BURDENLINE_DB_WAL,
      busyTimeoutMs: values.BURDENLINE_DB_BUSY_TIMEOUT_MS,
    }),
    auth: Object.freeze({
      jwtSecret,
      tokenTtlMinutes: values.BURDENLINE_TOKEN_TTL_MINUTES,
    }),
    logging: Object.freeze({
      level: values.BURDENLINE_LOG_LEVEL,
    }),
    site: Object.freeze({
      zone: values.BURDENLINE_SITE_ZONE,
    }),
    warnings: Object.freeze(warnings),
  });
}

/** Everything a settings page may show. The secret is never one of them. */
export function describeConfig(config) {
  return {
    env: config.env,
    host: config.http.host,
    port: config.http.port,
    database: config.database.file,
    walMode: config.database.walMode,
    logLevel: config.logging.level,
    siteZone: config.site.zone,
    tokenTtlMinutes: config.auth.tokenTtlMinutes,
  };
}
