/**
 * Sites and benches over HTTP.
 *
 * Route files are thin by rule: read the parameters, call the repository or the
 * service, hand back what it returned. Anything that looks like a decision in
 * here belongs in the domain, and the schemas are the only thing that stops a
 * malformed body reaching it.
 */

import * as sites from '../../db/repositories/sites.js';

const siteBody = {
  type: 'object',
  required: ['code', 'name'],
  additionalProperties: false,
  properties: {
    code: { type: 'string', pattern: '^[A-Z]{2,4}$' },
    name: { type: 'string', minLength: 2, maxLength: 120 },
    timeZone: { type: 'string', minLength: 1 },
    licenceNumber: { type: 'string' },
    gridEpsg: { type: 'integer' },
  },
};

const benchBody = {
  type: 'object',
  required: ['name', 'crestLevelM', 'toeLevelM', 'rockType', 'rockDensityKgM3'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    crestLevelM: { type: 'number' },
    toeLevelM: { type: 'number' },
    rockType: { type: 'string', minLength: 2, maxLength: 40 },
    rockDensityKgM3: { type: 'number', minimum: 1200, maximum: 4500 },
    ucsMpa: { type: 'number', exclusiveMinimum: 0 },
  },
};

export function siteRoutes(app) {
  const { db, clock } = app.deps;
  const context = { clock };

  app.get('/sites', { preHandler: app.requireGrant('read') }, async (request) => ({
    sites: sites.listSites(db, { page: request.query.page, pageSize: request.query.pageSize }),
  }));

  app.post(
    '/sites',
    { preHandler: app.requireGrant('administer'), schema: { body: siteBody } },
    async (request, reply) => {
      const site = sites.createSite(db, request.body, context);
      return reply.code(201).send({ site });
    },
  );

  app.get('/sites/:siteId', { preHandler: app.requireGrant('read') }, async (request) => ({
    site: sites.getSite(db, request.params.siteId),
    benches: sites.listBenches(db, request.params.siteId),
  }));

  app.patch(
    '/sites/:siteId',
    {
      preHandler: app.requireGrant('administer'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 2 },
            timeZone: { type: 'string' },
            licenceNumber: { type: 'string' },
            gridEpsg: { type: 'integer' },
          },
        },
      },
    },
    async (request) => ({
      site: sites.updateSite(db, request.params.siteId, request.body, context),
    }),
  );

  app.get('/sites/:siteId/benches', { preHandler: app.requireGrant('read') }, async (request) => ({
    benches: sites
      .listBenches(db, request.params.siteId, { status: request.query.status })
      .map((bench) => ({ ...bench, heightM: sites.benchHeightM(bench) })),
  }));

  app.post(
    '/sites/:siteId/benches',
    { preHandler: app.requireGrant('design'), schema: { body: benchBody } },
    async (request, reply) => {
      const bench = sites.createBench(
        db,
        { ...request.body, siteId: request.params.siteId },
        context,
      );
      return reply.code(201).send({ bench: { ...bench, heightM: sites.benchHeightM(bench) } });
    },
  );

  app.patch(
    '/benches/:benchId',
    {
      preHandler: app.requireGrant('design'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            crestLevelM: { type: 'number' },
            toeLevelM: { type: 'number' },
            rockType: { type: 'string' },
            rockDensityKgM3: { type: 'number' },
            ucsMpa: { type: 'number' },
            status: { type: 'string', enum: ['active', 'worked_out', 'suspended'] },
          },
        },
      },
    },
    async (request) => ({
      bench: sites.updateBench(db, request.params.benchId, request.body, context),
    }),
  );

  app.post(
    '/benches/:benchId/retire',
    { preHandler: app.requireGrant('design') },
    async (request) => ({
      bench: sites.retireBench(db, request.params.benchId, context),
    }),
  );

  return app;
}
