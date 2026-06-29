/**
 * The magazine over HTTP.
 *
 * Two things here are deliberately awkward for a caller and both are on purpose.
 * A movement cannot be deleted, only corrected, so there is no delete route. And
 * the day-book is served as a file rather than as json, because what people
 * actually do with it is print it and put it in the folder the inspector asks
 * for.
 */

import { createMagazineService } from '../../services/magazine.service.js';
import * as explosives from '../../db/repositories/explosives.js';

const movementBody = {
  type: 'object',
  required: ['batchId', 'movement', 'quantity'],
  additionalProperties: false,
  properties: {
    batchId: { type: 'string', minLength: 1 },
    movement: {
      type: 'string',
      enum: [
        'receipt',
        'issue',
        'return',
        'consumption',
        'disposal',
        'transfer_in',
        'transfer_out',
        'stocktake',
      ],
    },
    quantity: { type: 'number' },
    massKg: { type: 'number' },
    unit: { type: 'string', enum: ['kg', 'each', 'metre'] },
    blastId: { type: 'string' },
    reference: { type: 'string', maxLength: 60 },
    reason: { type: 'string', maxLength: 500 },
    occurredAt: { type: 'string' },
  },
};

export function magazineRoutes(app) {
  const { db, clock, logger } = app.deps;
  const context = { clock };
  const service = createMagazineService({ db, clock, logger });

  app.get(
    '/sites/:siteId/magazines',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      magazines: explosives.listMagazines(db, request.params.siteId).map((magazine) => ({
        ...magazine,
        stock: explosives.stockFor(db, magazine.id),
      })),
    }),
  );

  app.post(
    '/sites/:siteId/magazines',
    {
      preHandler: app.requireGrant('administer'),
      schema: {
        body: {
          type: 'object',
          required: ['name', 'netExplosiveLimitKg'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 60 },
            licenceNumber: { type: 'string', maxLength: 40 },
            kind: { type: 'string', enum: ['store', 'detonator_store', 'day_box', 'mobile_unit'] },
            netExplosiveLimitKg: { type: 'number', exclusiveMinimum: 0 },
            detonatorLimit: { type: 'integer', exclusiveMinimum: 0 },
            eastingM: { type: 'number' },
            northingM: { type: 'number' },
          },
        },
      },
    },
    async (request, reply) => {
      const magazine = explosives.createMagazine(
        db,
        { ...request.body, siteId: request.params.siteId },
        context,
      );
      return reply.code(201).send({ magazine });
    },
  );

  app.get(
    '/magazines/:magazineId/stock',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      stock: explosives.stockFor(db, request.params.magazineId),
    }),
  );

  app.get(
    '/magazines/:magazineId/ledger',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      lines: explosives.ledgerFor(db, request.params.magazineId, {
        from: request.query.from,
        to: request.query.to,
      }),
    }),
  );

  app.post(
    '/magazines/:magazineId/movements',
    { preHandler: app.requireGrant('magazine'), schema: { body: movementBody } },
    async (request, reply) => {
      const line = explosives.recordMovement(
        db,
        { ...request.body, magazineId: request.params.magazineId, personId: request.actor.id },
        context,
      );
      return reply.code(201).send({ line });
    },
  );

  app.post(
    '/magazines/:magazineId/corrections',
    {
      preHandler: app.requireGrant('magazine'),
      schema: {
        body: {
          type: 'object',
          required: ['ledgerId', 'quantity', 'reason'],
          additionalProperties: false,
          properties: {
            ledgerId: { type: 'string', minLength: 1 },
            quantity: { type: 'number' },
            reason: { type: 'string', minLength: 5, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const line = explosives.correctMovement(
        db,
        { ...request.body, personId: request.actor.id },
        context,
      );
      return reply.code(201).send({ line });
    },
  );

  app.post(
    '/blasts/:blastId/issues',
    {
      preHandler: app.requireGrant('magazine'),
      schema: {
        body: {
          type: 'object',
          required: ['magazineId', 'items'],
          additionalProperties: false,
          properties: {
            magazineId: { type: 'string', minLength: 1 },
            items: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['productCode', 'quantity'],
                additionalProperties: false,
                properties: {
                  productCode: { type: 'string', minLength: 2 },
                  quantity: { type: 'number', exclusiveMinimum: 0 },
                  unit: { type: 'string', enum: ['kg', 'each', 'metre'] },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        service.issueForBlast({
          blastId: request.params.blastId,
          magazineId: request.body.magazineId,
          items: request.body.items,
          personId: request.actor.id,
        }),
      ),
  );

  app.get(
    '/blasts/:blastId/reconciliation',
    { preHandler: app.requireGrant('read') },
    async (request) => service.reconcile({ blastId: request.params.blastId }),
  );

  app.get(
    '/magazines/:magazineId/daybook.csv',
    { preHandler: app.requireGrant('read') },
    async (request, reply) => {
      const magazine = explosives.getMagazine(db, request.params.magazineId);
      const book = service.daybook({
        siteId: magazine.siteId,
        magazineId: magazine.id,
        date: request.query.date ?? clock.date(),
        zone: app.deps.config?.site?.zone ?? 'UTC',
      });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="daybook-${book.day.date}.csv"`)
        .send(book.csv);
    },
  );

  app.get('/products', { preHandler: app.requireGrant('read') }, async (request) => ({
    products: explosives.listProducts(db, { kind: request.query.kind }),
  }));

  app.post(
    '/products',
    {
      preHandler: app.requireGrant('administer'),
      schema: {
        body: {
          type: 'object',
          required: ['code', 'name', 'kind'],
          additionalProperties: false,
          properties: {
            code: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9-]*$' },
            name: { type: 'string', minLength: 3, maxLength: 80 },
            kind: {
              type: 'string',
              enum: [
                'bulk_anfo',
                'bulk_emulsion',
                'bulk_blend',
                'packaged_emulsion',
                'cartridge',
                'booster',
                'detonator',
                'detonating_cord',
                'shock_tube',
              ],
            },
            densityKgM3: { type: 'number', minimum: 200, maximum: 2000 },
            relativeWeightStrength: { type: 'number', minimum: 10, maximum: 200 },
            velocityOfDetonationMs: { type: 'number', minimum: 1000, maximum: 9000 },
            waterResistance: { type: 'string', enum: ['none', 'limited', 'good', 'excellent'] },
            minimumDiameterMm: { type: 'number', minimum: 10, maximum: 400 },
            sleepTimeHours: { type: 'integer', minimum: 0, maximum: 2160 },
            unNumber: { type: 'string', pattern: '^UN[0-9]{4}$' },
            hazardDivision: { type: 'string', enum: ['1.1D', '1.1B', '1.4B', '1.4S', '1.5D'] },
            compatibilityGroup: { type: 'string', enum: ['B', 'D', 'S'] },
            unitMassKg: { type: 'number', exclusiveMinimum: 0, maximum: 50 },
            isExplosive: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send({ product: explosives.createProduct(db, request.body, context) }),
  );

  app.post(
    '/products/:productId/batches',
    {
      preHandler: app.requireGrant('magazine'),
      schema: {
        body: {
          type: 'object',
          required: ['batchCode'],
          additionalProperties: false,
          properties: {
            batchCode: { type: 'string', minLength: 1, maxLength: 40 },
            manufacturedOn: { type: 'string' },
            expiresOn: { type: 'string' },
            supplier: { type: 'string' },
            deliveryNote: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send({
        batch: explosives.createBatch(
          db,
          { ...request.body, productId: request.params.productId },
          context,
        ),
      }),
  );

  return app;
}
