/**
 * The shot over HTTP.
 *
 * Every transition is its own route rather than a patch on a state field. The
 * difference matters: a patch invites a client to set the state it wants, and
 * the whole point of the lifecycle is that a client asks for a move and the
 * domain decides whether it is allowed from where the shot actually is.
 */

import * as blasts from '../../db/repositories/blasts.js';
import * as sites from '../../db/repositories/sites.js';
import { actionsFrom, describeState } from '../../domain/firing/lifecycle.js';
import { reasonBody } from '../schemas.js';

export function blastRoutes(app) {
  const { db, clock } = app.deps;
  const context = { clock };

  function move(path, action, { grant, body = null, contextFrom = () => ({}) }) {
    app.post(
      path,
      { preHandler: app.requireGrant(grant), ...(body ? { schema: { body } } : {}) },
      async (request) => {
        const result = blasts.transition(
          db,
          request.params.blastId,
          action,
          { actorId: request.actor.id, ...contextFrom(request) },
          context,
        );
        return { blast: result.blast, event: result.event, next: actionsFrom(result.blast.state) };
      },
    );
  }

  app.post(
    '/sites/:siteId/blasts',
    {
      preHandler: app.requireGrant('design'),
      schema: {
        body: {
          type: 'object',
          required: ['reference'],
          additionalProperties: false,
          properties: {
            reference: { type: 'string', minLength: 3, maxLength: 24 },
            patternId: { type: 'string' },
            plannedFor: { type: 'string' },
            note: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      sites.getSite(db, request.params.siteId);
      const blast = blasts.createBlast(
        db,
        { ...request.body, siteId: request.params.siteId, designedBy: request.actor.id },
        context,
      );
      return reply.code(201).send({ blast, next: actionsFrom(blast.state) });
    },
  );

  app.get('/sites/:siteId/blasts', { preHandler: app.requireGrant('read') }, async (request) => ({
    blasts: blasts
      .listBlasts(db, request.params.siteId, {
        state: request.query.state,
        page: request.query.page,
        pageSize: request.query.pageSize,
      })
      .map((blast) => ({ ...blast, stateDescription: describeState(blast.state) })),
  }));

  app.get('/blasts/:blastId', { preHandler: app.requireGrant('read') }, async (request) => {
    const blast = blasts.getBlast(db, request.params.blastId);
    return {
      blast,
      stateDescription: describeState(blast.state),
      next: actionsFrom(blast.state),
      events: blasts.eventsFor(db, blast.id),
      decks: blasts.decksFor(db, blast.id),
      tieIn: blasts.tieInFor(db, blast.id),
    };
  });

  app.put(
    '/blasts/:blastId/tie-in',
    {
      preHandler: app.requireGrant('design'),
      schema: {
        body: {
          type: 'object',
          required: ['connectors'],
          additionalProperties: false,
          properties: {
            connectors: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['fromHole', 'toHole', 'delayMs'],
                additionalProperties: false,
                properties: {
                  fromHole: { type: 'integer', minimum: 1 },
                  toHole: { type: 'integer', minimum: 1 },
                  delayMs: { type: 'number', minimum: 0, maximum: 20000 },
                  detonatorCode: { type: 'string', maxLength: 16 },
                },
              },
            },
          },
        },
      },
    },
    async (request) =>
      blasts.replaceTieIn(db, request.params.blastId, request.body.connectors, context),
  );

  app.put(
    '/blasts/:blastId/totals',
    {
      preHandler: app.requireGrant('design'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            totalChargeKg: { type: 'number', minimum: 0 },
            instantaneousChargeKg: { type: 'number', minimum: 0 },
            holeCount: { type: 'integer', minimum: 0 },
            volumeM3: { type: 'number', minimum: 0 },
            powderFactorKgM3: { type: 'number', minimum: 0 },
          },
        },
      },
    },
    async (request) => ({
      blast: blasts.recordDesignTotals(db, request.params.blastId, request.body, context),
    }),
  );

  move('/blasts/:blastId/complete-design', 'complete_design', { grant: 'design' });
  move('/blasts/:blastId/submit', 'submit', { grant: 'design' });
  move('/blasts/:blastId/approve', 'approve', {
    grant: 'approve',
    contextFrom: (request) => ({ approverId: request.actor.id }),
  });
  move('/blasts/:blastId/reject', 'reject', {
    grant: 'approve',
    body: reasonBody,
    contextFrom: (request) => ({ reason: request.body.reason }),
  });
  move('/blasts/:blastId/revise', 'revise', { grant: 'design' });
  move('/blasts/:blastId/load', 'load', {
    grant: 'fire',
    contextFrom: (request) => ({ shotfirerId: request.actor.id }),
  });
  move('/blasts/:blastId/tie-in-complete', 'tie_in', { grant: 'fire' });
  move('/blasts/:blastId/inspect', 'inspect', {
    grant: 'fire',
    contextFrom: (request) => ({ inspectorId: request.actor.id }),
  });
  move('/blasts/:blastId/close', 'close', { grant: 'approve' });
  move('/blasts/:blastId/abandon', 'abandon', {
    grant: 'approve',
    body: reasonBody,
    contextFrom: (request) => ({ reason: request.body.reason }),
  });

  return app;
}
