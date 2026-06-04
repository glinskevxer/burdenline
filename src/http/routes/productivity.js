/**
 * How the site is going, over HTTP.
 *
 * Three reads and nothing to write. Everything on them is worked out from
 * records that were made for another reason, so there is no form behind any of
 * it and nothing to keep up to date.
 */

import { createProductivityService } from '../../services/productivity.service.js';

const periodQuery = {
  type: 'object',
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', minLength: 4 },
    to: { type: 'string', minLength: 4 },
  },
};

export function productivityRoutes(app) {
  const { db, clock } = app.deps;
  const service = createProductivityService({ db, clock });

  app.get(
    '/sites/:siteId/productivity',
    { preHandler: app.requireGrant('read'), schema: { querystring: periodQuery } },
    async (request) =>
      service.period({
        siteId: request.params.siteId,
        from: request.query.from,
        to: request.query.to,
      }),
  );

  app.get(
    '/sites/:siteId/productivity/rigs',
    { preHandler: app.requireGrant('read'), schema: { querystring: periodQuery } },
    async (request) =>
      service.rigs({
        siteId: request.params.siteId,
        from: request.query.from,
        to: request.query.to,
      }),
  );

  app.get(
    '/sites/:siteId/productivity/trend',
    {
      preHandler: app.requireGrant('read'),
      schema: {
        querystring: {
          type: 'object',
          required: ['from', 'to', 'previousFrom', 'previousTo'],
          properties: {
            from: { type: 'string', minLength: 4 },
            to: { type: 'string', minLength: 4 },
            previousFrom: { type: 'string', minLength: 4 },
            previousTo: { type: 'string', minLength: 4 },
          },
        },
      },
    },
    async (request) =>
      service.trend({
        siteId: request.params.siteId,
        current: { from: request.query.from, to: request.query.to },
        previous: { from: request.query.previousFrom, to: request.query.previousTo },
      }),
  );

  return app;
}
