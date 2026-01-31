/**
 * Surveys, digging and secondary breaking over HTTP.
 *
 * The yield route is the one that gets read: it is the answer to what the shot
 * was worth, and it is deliberately the only place that puts the design volume,
 * the survey and the weighbridge beside each other, so nobody has to decide
 * which one to believe on their own.
 */

import * as production from '../../db/repositories/production.js';

const surveyBody = {
  type: 'object',
  required: ['method', 'volumeM3'],
  additionalProperties: false,
  properties: {
    method: {
      type: 'string',
      enum: ['laser_scan', 'drone_photogrammetry', 'total_station', 'truck_count', 'weighbridge'],
    },
    volumeM3: { type: 'number', exclusiveMinimum: 0 },
    tonnes: { type: 'number', exclusiveMinimum: 0 },
    densityKgM3: { type: 'number', exclusiveMinimum: 0 },
    surveyedAt: { type: 'string' },
    note: { type: 'string', maxLength: 500 },
  },
};

const digBody = {
  type: 'object',
  required: ['tonnes', 'hours'],
  additionalProperties: false,
  properties: {
    recordedOn: { type: 'string' },
    loader: { type: 'string', maxLength: 40 },
    buckets: { type: 'integer', minimum: 0 },
    tonnes: { type: 'number', minimum: 0 },
    hours: { type: 'number', exclusiveMinimum: 0 },
    delayMinutes: { type: 'number', minimum: 0 },
    delayReason: { type: 'string', maxLength: 200 },
  },
};

const breakingBody = {
  type: 'object',
  required: ['method'],
  additionalProperties: false,
  properties: {
    carriedOutOn: { type: 'string' },
    method: {
      type: 'string',
      enum: ['hydraulic_hammer', 'pop_shooting', 'plaster_shooting', 'drop_ball'],
    },
    boulderCount: { type: 'integer', minimum: 0 },
    hours: { type: 'number', minimum: 0 },
    explosiveUsedKg: { type: 'number', minimum: 0 },
    note: { type: 'string', maxLength: 500 },
  },
};

export function productionRoutes(app) {
  const { db, clock } = app.deps;

  app.post(
    '/blasts/:blastId/surveys',
    { preHandler: app.requireGrant('design'), schema: { body: surveyBody } },
    async (request, reply) =>
      reply.code(201).send({
        survey: production.recordSurvey(
          db,
          { ...request.body, blastId: request.params.blastId },
          { clock, actorId: request.actor.id },
        ),
      }),
  );

  app.get(
    '/blasts/:blastId/surveys',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      surveys: production.listSurveys(db, request.params.blastId),
      preferred: production.bestSurvey(db, request.params.blastId),
    }),
  );

  app.post(
    '/blasts/:blastId/dig-records',
    { preHandler: app.requireGrant('read'), schema: { body: digBody } },
    async (request, reply) =>
      reply.code(201).send({
        record: production.recordDig(
          db,
          { ...request.body, blastId: request.params.blastId },
          { clock },
        ),
      }),
  );

  app.get(
    '/blasts/:blastId/digging',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      records: production.listDigRecords(db, request.params.blastId),
      rate: production.diggingFor(db, request.params.blastId),
    }),
  );

  app.post(
    '/blasts/:blastId/secondary-breaking',
    { preHandler: app.requireGrant('read'), schema: { body: breakingBody } },
    async (request, reply) =>
      reply.code(201).send({
        record: production.recordSecondaryBreaking(
          db,
          { ...request.body, blastId: request.params.blastId },
          { clock, actorId: request.actor.id },
        ),
      }),
  );

  app.get('/blasts/:blastId/yield', { preHandler: app.requireGrant('read') }, async (request) => ({
    yield: production.yieldFor(db, request.params.blastId, {
      truckedTonnes: request.query.truckedTonnes ? Number(request.query.truckedTonnes) : null,
      densityKgM3: request.query.densityKgM3 ? Number(request.query.densityKgM3) : 2700,
    }),
    secondaryBreaking: {
      records: production.listSecondaryBreaking(db, request.params.blastId),
      hours: production.secondaryBreakingHours(db, request.params.blastId),
    },
  }));

  app.get(
    '/sites/:siteId/surveys',
    {
      preHandler: app.requireGrant('read'),
      schema: {
        querystring: {
          type: 'object',
          required: ['from', 'to'],
          properties: { from: { type: 'string' }, to: { type: 'string' } },
        },
      },
    },
    async (request) => ({
      surveys: production.surveysInPeriod(db, request.params.siteId, {
        from: request.query.from,
        to: request.query.to,
      }),
    }),
  );

  return app;
}
