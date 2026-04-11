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
import { blastRoutes } from './routes/blasts.js';
import { firingRoutes } from './routes/firing.js';
import { magazineRoutes } from './routes/magazine.js';
import { monitoringRoutes } from './routes/monitoring.js';
import { designRoutes } from './routes/design.js';
import { postblastRoutes } from './routes/postblast.js';
import { complaintRoutes } from './routes/complaints.js';
import { reportRoutes } from './routes/reports.js';
import { productionRoutes } from './routes/production.js';
import { siteRuleRoutes } from './routes/site-rules.js';
import { rigRoutes } from './routes/rigs.js';
import { orderRoutes } from './routes/orders.js';
import { registerDescribe } from './plugins/describe.js';
import { registerIdempotency } from './plugins/idempotency.js';

export async function buildApp(options) {
  const app = await buildServer(options);
  await registerAuth(app, { config: options.config });
  registerDescribe(app);
  registerIdempotency(app);
  authRoutes(app);
  siteRoutes(app);
  patternRoutes(app);
  blastRoutes(app);
  firingRoutes(app);
  magazineRoutes(app);
  monitoringRoutes(app);
  designRoutes(app);
  postblastRoutes(app);
  complaintRoutes(app);
  productionRoutes(app);
  siteRuleRoutes(app);
  rigRoutes(app);
  orderRoutes(app);
  reportRoutes(app);
  return app;
}
