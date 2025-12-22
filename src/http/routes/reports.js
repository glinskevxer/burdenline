/**
 * Reports.
 *
 * Three of them and they are different things. A shot report is one blast
 * gathered from everywhere. A period report is the month. The regulator pack is
 * the return that gets emailed, and it comes back as a set of files rather than
 * as a document, because what happens to it next is that somebody attaches them.
 */

import { createReportingService } from '../../services/reporting.service.js';
import { buildPack, renderPack } from '../../domain/reporting/regulator-pack.js';
import { createMonitoringService } from '../../services/monitoring.service.js';
import * as sites from '../../db/repositories/sites.js';
import * as blasts from '../../db/repositories/blasts.js';
import * as monitoring from '../../db/repositories/monitoring.js';
import * as community from '../../db/repositories/community.js';
import * as postblast from '../../db/repositories/postblast.js';
import { historyFor, byActor, since } from '../../db/audit.js';

const periodQuery = {
  type: 'object',
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', minLength: 4 },
    to: { type: 'string', minLength: 4 },
  },
};

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
      const site = sites.getSite(db, request.params.siteId);
      const { from, to } = request.query;
      const fired = blasts
        .listBlasts(db, site.id, { pageSize: 200 })
        .filter((blast) => blast.firedAt && blast.firedAt >= from && blast.firedAt <= to);
      const assessment = monitoringService.assess({ siteId: site.id, from, to });
      const receptors = new Map(monitoring.listReceptors(db, site.id).map((r) => [r.id, r.name]));
      const records = monitoring
        .listRecords(db, site.id, { from, to, limit: 2000 })
        .map((record) => ({
          ...record,
          receptorName: receptors.get(record.receptorId) ?? null,
        }));
      const misfires = fired.flatMap((blast) =>
        postblast
          .listMisfires(db, blast.id)
          .map((misfire) => ({ ...misfire, blastReference: blast.reference })),
      );
      const pack = buildPack({
        siteName: site.name,
        licenceNumber: site.licenceNumber ?? 'not recorded',
        from,
        to,
        preparedBy: request.actor.name ?? request.actor.id,
        preparedAt: clock.now(),
        blasts: fired,
        records,
        exceedances: assessment.exceedances.map((item) => ({
          ...item,
          receptorName: receptors.get(item.receptorId) ?? null,
        })),
        complaints: community.listComplaints(db, site.id, { from, to, limit: 500 }),
        misfires,
      });
      return request.query.format === 'files' ? { files: renderPack(pack) } : { pack };
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
