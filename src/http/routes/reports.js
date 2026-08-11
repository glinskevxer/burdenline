/**
 * Reports.
 *
 * Three of them and they are different things. A shot report is one blast
 * gathered from everywhere. A period report is the month. The regulator pack is
 * the return that gets emailed, and it comes back as a set of files rather than
 * as a document, because what happens to it next is that somebody attaches them.
 */

import { createReportingService } from '../../services/reporting.service.js';
import { createMonitoringService } from '../../services/monitoring.service.js';
import { historyFor, byActor, since } from '../../db/audit.js';
import { periodQuery } from '../schemas.js';

export function reportRoutes(app) {
  const { db, clock, logger } = app.deps;
  const reporting = createReportingService({ db, clock });
  const monitoringService = createMonitoringService({ db, clock, logger });

  app.get('/blasts/:blastId/report', { preHandler: app.requireGrant('read') }, async (request) =>
    reporting.blastReport({
      blastId: request.params.blastId,
      labourHours: Number(request.query.labourHours ?? 0),
      secondaryBreakingHours: Number(request.query.secondaryBreakingHours ?? 0),
    }),
  );

  app.get(
    '/sites/:siteId/report',
    { preHandler: app.requireGrant('read'), schema: { querystring: periodQuery } },
    async (request) =>
      reporting.periodReport({
        siteId: request.params.siteId,
        from: request.query.from,
        to: request.query.to,
      }),
  );

  app.get(
    '/sites/:siteId/scorecard',
    { preHandler: app.requireGrant('read'), schema: { querystring: periodQuery } },
    async (request) =>
      reporting.scorecard({
        siteId: request.params.siteId,
        from: request.query.from,
        to: request.query.to,
      }),
  );

  app.get(
    '/sites/:siteId/regulator-pack',
    { preHandler: app.requireGrant('read'), schema: { querystring: periodQuery } },
    async (request) => {
      const { from, to } = request.query;
      return reporting.regulatorPack({
        siteId: request.params.siteId,
        from,
        to,
        preparedBy: request.actor.name ?? request.actor.id,
        assessment: monitoringService.assess({ siteId: request.params.siteId, from, to }),
        format: request.query.format,
      });
    },
  );

  app.get(
    '/audit/:entityKind/:entityId',
    { preHandler: app.requireGrant('administer') },
    async (request) => ({
      history: historyFor(db, request.params.entityKind, request.params.entityId, {
        limit: Number(request.query.limit ?? 100),
      }),
    }),
  );

  app.get('/audit', { preHandler: app.requireGrant('administer') }, async (request) => ({
    entries: request.query.actorId
      ? byActor(db, request.query.actorId, { limit: Number(request.query.limit ?? 100) })
      : since(db, request.query.from ?? '1970-01-01T00:00:00.000Z', {
          limit: Number(request.query.limit ?? 100),
        }),
  }));

  return app;
}
