/**
 * Everything wired together.
 *
 * One function that takes a database and a clock and gives back a server with
 * every route on it. The tests use it as it stands; `src/index.js` adds the
 * listening socket and the signal handlers and nothing else, so what runs in
 * production is what the tests exercised.
 */

import { buildServer } from './server.js';
import { registerAuth, authRoutes } from './plugins/auth.js';
import { siteRoutes } from './routes/sites.js';
import { patternRoutes } from './routes/patterns.js';

export async function buildApp(options) {
  const app = await buildServer(options);
  await registerAuth(app, { config: options.config });
  authRoutes(app);
  siteRoutes(app);
  patternRoutes(app);
  return app;
}
