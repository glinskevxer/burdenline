/**
 * The drill fleet over HTTP.
 *
 * The route worth having here is the one that says which rigs can drill a given
 * pattern. Everything else is a list; that one stops a morning being wasted.
 */

import * as rigs from '../../db/repositories/rigs.js';

const rigBody = {
  type: 'object',
  required: ['fleetNumber', 'holeDiameterMinMm', 'holeDiameterMaxMm'],
  additionalProperties: false,
  properties: {
    fleetNumber: { type: 'string', minLength: 1, maxLength: 20 },
    make: { type: 'string', maxLength: 40 },
    model: { type: 'string', maxLength: 40 },
    holeDiameterMinMm: { type: 'number', minimum: 25, maximum: 400 },
    holeDiameterMaxMm: { type: 'number', minimum: 25, maximum: 400 },
    status: { type: 'string', enum: ['available', 'drilling', 'maintenance', 'down', 'retired'] },
  },
};

const shiftBody = {
  type: 'object',
  required: ['shift', 'hours'],
  additionalProperties: false,
  properties: {
    shift: { type: 'string', enum: ['day', 'back', 'night'] },
    shiftDate: { type: 'string' },
    patternId: { type: 'string' },
    metresDrilled: { type: 'number', minimum: 0 },
    holesDrilled: { type: 'integer', minimum: 0 },
    hours: { type: 'number', exclusiveMinimum: 0, maximum: 24 },
    downtimeMinutes: { type: 'number', minimum: 0 },
    downtimeReason: { type: 'string', maxLength: 200 },
  },
};

export function rigRoutes(app) {
  const { db, clock } = app.deps;
  const context = { clock };

  app.get('/sites/:siteId/rigs', { preHandler: app.requireGrant('read') }, async (request) => ({
    rigs: rigs.listRigs(db, request.params.siteId, { status: request.query.status }),
  }));

  app.post(
    '/sites/:siteId/rigs',
    { preHandler: app.requireGrant('administer'), schema: { body: rigBody } },
    async (request, reply) =>
      reply.code(201).send({
        rig: rigs.createRig(db, { ...request.body, siteId: request.params.siteId }, context),
      }),
  );

  app.patch(
    '/rigs/:rigId',
    {
      preHandler: app.requireGrant('design'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            make: { type: 'string' },
            model: { type: 'string' },
            holeDiameterMinMm: { type: 'number' },
            holeDiameterMaxMm: { type: 'number' },
            status: {
              type: 'string',
              enum: ['available', 'drilling', 'maintenance', 'down', 'retired'],
            },
          },
        },
      },
    },
    async (request) => ({ rig: rigs.updateRig(db, request.params.rigId, request.body, context) }),
  );

  app.post(
    '/rigs/:rigId/retire',
    { preHandler: app.requireGrant('administer') },
    async (request) => ({
      rig: rigs.retireRig(db, request.params.rigId, context),
    }),
  );

  app.get(
    '/patterns/:patternId/rigs',
    { preHandler: app.requireGrant('read') },
    async (request) => {
      const options = rigs.rigsForPattern(db, request.params.patternId);
      return {
        suitable: options.filter((option) => option.suitable).map((option) => option.rig),
        unsuitable: options
          .filter((option) => !option.suitable)
          .map((option) => ({ rig: option.rig, reasons: option.reasons })),
      };
    },
  );

  app.post(
    '/rigs/:rigId/shifts',
    { preHandler: app.requireGrant('read'), schema: { body: shiftBody } },
    async (request, reply) =>
      reply.code(201).send({
        shift: rigs.recordShift(
          db,
          { ...request.body, rigId: request.params.rigId, operatorId: request.actor.id },
          context,
        ),
      }),
  );

  app.get('/rigs/:rigId/shifts', { preHandler: app.requireGrant('read') }, async (request) => ({
    shifts: rigs.listShifts(db, request.params.rigId, {
      from: request.query.from,
      to: request.query.to,
    }),
    productivity: rigs.rigProductivity(db, request.params.rigId, {
      from: request.query.from,
      to: request.query.to,
    }),
  }));

  return app;
}
