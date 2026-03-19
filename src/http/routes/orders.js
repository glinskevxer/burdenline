/**
 * Ordering and deliveries over HTTP.
 *
 * The review route is the one that earns its place: it says what to order and
 * how much, worked out from what has actually been used rather than from
 * whatever number is written on the store door.
 */

import * as orders from '../../db/repositories/orders.js';

const orderBody = {
  type: 'object',
  required: ['supplier', 'reference', 'lines'],
  additionalProperties: false,
  properties: {
    supplier: { type: 'string', minLength: 2, maxLength: 80 },
    reference: { type: 'string', minLength: 2, maxLength: 40 },
    expectedOn: { type: 'string' },
    note: { type: 'string', maxLength: 500 },
    lines: {
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
};

const deliveryBody = {
  type: 'object',
  required: ['magazineId', 'items'],
  additionalProperties: false,
  properties: {
    magazineId: { type: 'string', minLength: 1 },
    deliveryNote: { type: 'string', maxLength: 60 },
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['productCode', 'quantity', 'batchCode'],
        additionalProperties: false,
        properties: {
          productCode: { type: 'string', minLength: 2 },
          quantity: { type: 'number', exclusiveMinimum: 0 },
          massKg: { type: 'number', exclusiveMinimum: 0 },
          batchCode: { type: 'string', minLength: 1, maxLength: 40 },
          manufacturedOn: { type: 'string' },
          expiresOn: { type: 'string' },
        },
      },
    },
  },
};

export function orderRoutes(app) {
  const { db, clock } = app.deps;
  const context = { clock };

  app.get('/sites/:siteId/orders', { preHandler: app.requireGrant('read') }, async (request) => ({
    orders: orders.listOrders(db, request.params.siteId, { state: request.query.state }),
    onOrder: orders.onOrder(db, request.params.siteId),
  }));

  app.post(
    '/sites/:siteId/orders',
    { preHandler: app.requireGrant('magazine'), schema: { body: orderBody } },
    async (request, reply) =>
      reply.code(201).send({
        order: orders.placeOrder(
          db,
          { ...request.body, siteId: request.params.siteId },
          { clock, actorId: request.actor.id },
        ),
      }),
  );

  app.get('/orders/:orderId', { preHandler: app.requireGrant('read') }, async (request) => ({
    order: orders.getOrder(db, request.params.orderId),
  }));

  app.post(
    '/orders/:orderId/deliveries',
    { preHandler: app.requireGrant('magazine'), schema: { body: deliveryBody } },
    async (request, reply) =>
      reply.code(201).send({
        order: orders.receiveDelivery(
          db,
          {
            orderId: request.params.orderId,
            magazineId: request.body.magazineId,
            items: request.body.items,
            deliveryNote: request.body.deliveryNote,
            personId: request.actor.id,
          },
          context,
        ),
      }),
  );

  // No body schema: cancelling is a button press, and a route that demands a
  // body answers 422 to one. The reason is optional and trimmed here.
  app.post(
    '/orders/:orderId/cancel',
    { preHandler: app.requireGrant('magazine') },
    async (request) => ({
      order: orders.cancelOrder(db, request.params.orderId, {
        clock,
        reason:
          typeof request.body?.reason === 'string' ? request.body.reason.slice(0, 500) : undefined,
      }),
    }),
  );

  app.get(
    '/sites/:siteId/supply-review',
    { preHandler: app.requireGrant('read') },
    async (request) => orders.reviewSupply(db, request.params.siteId, { from: request.query.from }),
  );

  return app;
}
