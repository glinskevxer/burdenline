/**
 * Receptors, monitor records and the site law.
 *
 * The import route takes the raw text of whatever the monitor wrote. It does not
 * ask which make it came from, because the person uploading it does not
 * reliably know, and the format is detectable from the file itself.
 */

import { createMonitoringService } from '../../services/monitoring.service.js';
import * as monitoring from '../../db/repositories/monitoring.js';

const receptorBody = {
  type: 'object',
  required: ['name', 'structureClass', 'easting', 'northing'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 120 },
    structureClass: {
      type: 'string',
      enum: [
        'dwelling',
        'older_dwelling',
        'listed',
        'heritage',
        'commercial',
        'industrial',
        'buried_service',
        'water_feature',
      ],
    },
    easting: { type: 'number' },
    northing: { type: 'number' },
    level: { type: 'number' },
    occupied: { type: 'boolean' },
    limitMmPerSecond: { type: 'number', exclusiveMinimum: 0, maximum: 200 },
    airblastLimitDb: { type: 'number', minimum: 90, maximum: 160 },
    typicalFrequencyHz: { type: 'number', exclusiveMinimum: 0 },
    monitored: { type: 'boolean' },
    notifiable: { type: 'boolean' },
    note: { type: 'string', maxLength: 500 },
  },
};

export function monitoringRoutes(app) {
  const { db, clock, logger } = app.deps;
  const context = { clock };
  const service = createMonitoringService({ db, clock, logger });

  app.get(
    '/sites/:siteId/receptors',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      receptors: monitoring.listReceptors(db, request.params.siteId, {
        monitoredOnly: request.query.monitored === 'true',
      }),
    }),
  );

  app.post(
    '/sites/:siteId/receptors',
    { preHandler: app.requireGrant('administer'), schema: { body: receptorBody } },
    async (request, reply) =>
      reply.code(201).send({
        receptor: monitoring.createReceptor(
          db,
          { ...request.body, siteId: request.params.siteId },
          context,
        ),
      }),
  );

  app.patch(
    '/receptors/:receptorId',
    {
      preHandler: app.requireGrant('administer'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            structureClass: { type: 'string' },
            limitMmPerSecond: { type: 'number', exclusiveMinimum: 0 },
            airblastLimitDb: { type: 'number' },
            typicalFrequencyHz: { type: 'number' },
            occupied: { type: 'boolean' },
            monitored: { type: 'boolean' },
            notifiable: { type: 'boolean' },
            note: { type: 'string' },
          },
        },
      },
    },
    async (request) => ({
      receptor: monitoring.updateReceptor(db, request.params.receptorId, request.body, context),
    }),
  );

  app.post(
    '/sites/:siteId/monitor-records',
    {
      preHandler: app.requireGrant('monitoring'),
      schema: {
        body: {
          type: 'object',
          required: ['csv'],
          additionalProperties: false,
          properties: {
            csv: { type: 'string', minLength: 1 },
            receptorId: { type: 'string' },
            distanceM: { type: 'number', exclusiveMinimum: 0 },
            format: { type: 'string', enum: ['instantel', 'vibratech'] },
            sourceFile: { type: 'string', maxLength: 120 },
          },
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        service.ingest({
          siteId: request.params.siteId,
          text: request.body.csv,
          receptorId: request.body.receptorId ?? null,
          distanceM: request.body.distanceM ?? null,
          format: request.body.format,
          sourceFile: request.body.sourceFile ?? null,
        }),
      ),
  );

  app.get(
    '/sites/:siteId/monitor-records',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      records: monitoring.listRecords(db, request.params.siteId, {
        from: request.query.from,
        to: request.query.to,
        receptorId: request.query.receptorId,
        blastId: request.query.blastId,
        limit: Number(request.query.limit ?? 200),
      }),
    }),
  );

  app.get(
    '/sites/:siteId/monitor-records/unmatched',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      suggestions: service.suggestMatches({
        siteId: request.params.siteId,
        from: request.query.from,
        to: request.query.to,
      }),
    }),
  );

  app.post(
    '/sites/:siteId/monitor-records/match',
    { preHandler: app.requireGrant('monitoring') },
    async (request) => service.attachUnambiguous({ siteId: request.params.siteId }),
  );

  app.post(
    '/monitor-records/:recordId/blast',
    {
      preHandler: app.requireGrant('monitoring'),
      schema: {
        body: {
          type: 'object',
          required: ['blastId'],
          additionalProperties: false,
          properties: { blastId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request) => ({
      record: service.attach({ recordId: request.params.recordId, blastId: request.body.blastId }),
    }),
  );

  app.get('/sites/:siteId/compliance', { preHandler: app.requireGrant('read') }, async (request) =>
    service.assess({
      siteId: request.params.siteId,
      from: request.query.from,
      to: request.query.to,
    }),
  );

  app.get(
    '/blasts/:blastId/monitoring',
    { preHandler: app.requireGrant('read') },
    async (request) => service.forBlast({ blastId: request.params.blastId }),
  );

  app.get('/sites/:siteId/site-law', { preHandler: app.requireGrant('read') }, async (request) => ({
    law: service.currentLaw({
      siteId: request.params.siteId,
      receptorId: request.query.receptorId ?? null,
    }),
    history: monitoring.siteLawHistory(db, request.params.siteId),
  }));

  app.post(
    '/sites/:siteId/site-law',
    {
      preHandler: app.requireGrant('monitoring'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            receptorId: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            minimumRecords: { type: 'integer', minimum: 6, maximum: 500 },
            confidence: { type: 'number', enum: [0.5, 0.8, 0.9, 0.95, 0.99] },
          },
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        service.refit({
          siteId: request.params.siteId,
          receptorId: request.body?.receptorId ?? null,
          from: request.body?.from,
          to: request.body?.to,
          minimumRecords: request.body?.minimumRecords ?? 8,
          confidence: request.body?.confidence ?? null,
        }),
      ),
  );

  return app;
}
