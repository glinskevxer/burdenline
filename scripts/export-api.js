#!/usr/bin/env node
/**
 * Write the api description out to a file.
 *
 * Generated from the routes the server actually registers, so it cannot drift
 * from what is served. It is checked into the repository on purpose: a change
 * that adds or removes a route shows up in the diff, which is the cheapest
 * possible review of an api change.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config/env.js';
import { openDatabase, closeDatabase } from '../src/db/connection.js';
import { createClock } from '../src/lib/clock.js';
import { silentLogger } from '../src/lib/logger.js';

const OUT = 'api.json';

export async function describeApi() {
  const config = loadConfig({
    NODE_ENV: 'test',
    BURDENLINE_DB: ':memory:',
    BURDENLINE_JWT_SECRET: 'a-secret-long-enough-for-the-description-run',
  });
  const db = openDatabase(config);
  const app = await buildApp({ config, db, clock: createClock(), logger: silentLogger() });
  try {
    const response = await app.inject({ method: 'GET', url: '/describe' });
    return response.json();
  } finally {
    await app.close();
    closeDatabase(db);
  }
}

export function render(description) {
  return `${JSON.stringify(
    {
      service: description.service,
      routeCount: description.routeCount,
      routes: description.routes.map((route) => ({
        method: route.method,
        path: route.path,
        body: route.body,
        query: route.query,
      })),
    },
    null,
    2,
  )}\n`;
}

export function differs(existing, written) {
  return existing !== written;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const written = render(await describeApi());
  const check = process.argv.includes('--check');
  const existing = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  if (check) {
    if (differs(existing, written)) {
      console.error(`${OUT} is out of date, run: npm run api`);
      process.exitCode = 1;
    } else {
      console.log(`${OUT} matches the routes the server registers`);
    }
  } else {
    writeFileSync(OUT, written);
    console.log(`${OUT} written with ${JSON.parse(written).routeCount} routes`);
  }
}
