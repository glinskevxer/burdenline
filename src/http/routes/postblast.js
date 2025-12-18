/**
 * What happened after the shot, over HTTP.
 *
 * The inspection route and the misfire route are separate even though both are
 * filled in on the same walk, because a misfire has to be recordable in twenty
 * seconds on a phone while somebody stands looking at a standing hole, and it
 * cannot be behind a form that also wants the backbreak measured.
 */

import * as postblast from '../../db/repositories/postblast.js';
import * as community from '../../db/repositories/community.js';
import * as blasts from '../../db/repositories/blasts.js';
import * as monitoring from '../../db/repositories/monitoring.js';
import { buildList } from '../../domain/community/notifications.js';
import * as patterns from '../../db/repositories/patterns.js';

const inspectionBody = {
  type: 'object',
  required: ['muckpileShape', 'throwM', 'toeGrade'],
  additionalProperties: false,
  properties: {
    inspectedAt: { type: 'string' },
    muckpileShape: { type: 'string', enum: ['tight', 'moderate', 'loose', 'cast'] },
    throwM: { type: 'number', minimum: 0, maximum: 200 },
    muckpileHeightM: { type: 'number', minimum: 0, maximum: 60 },
    toeGrade: { type: 'string', enum: ['none', 'slight', 'moderate', 'severe'] },
    toeLengthM: { type: 'number', minimum: 0 },
    backbreakM: { type: 'number', minimum: 0, maximum: 30 },
    oversizeCount: { type: 'integer', minimum: 0 },
    faceStable: { type: 'boolean' },
    flyrockObserved: { type: 'boolean' },
    fumeGrade: { type: 'integer', minimum: 0, maximum: 5 },
    note: { type: 'string', maxLength: 1000 },
  },
};

const misfireBody = {
  type: 'object',
  required: ['holeNumbers', 'kind', 'description'],
  additionalProperties: false,
  properties: {
    holeNumbers: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
    kind: {
      type: 'string',
      enum: ['unfired_hole', 'partial_detonation', 'cut_off', 'unaccounted_explosive'],
    },
    discoveredAt: { type: 'string' },
    explosiveEstimateKg: { type: 'number', minimum: 0 },
    description: { type: 'string', minLength: 10, maxLength: 2000 },
  },
};

export function postblastRoutes(app) {
  const { db, clock } = app.deps;

  app.post(
    '/blasts/:blastId/inspection',
    { preHandler: app.requireGrant('fire'), schema: { body: inspectionBody } },
    async (request, reply) => {
      const blast = blasts.getBlast(db, request.params.blastId);
      const result = postblast.recordInspection(
        db,
        {
          ...request.body,
          blastId: blast.id,
          inspectedAt: request.body.inspectedAt ?? clock.now(),
          inspectedBy: request.actor.id,
        },
        { clock, actorId: request.actor.id, holeCount: blast.holeCount ?? 1 },
      );
      return reply.code(201).send(result);
    },
  );

  app.get(
    '/blasts/:blastId/inspection',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      inspection: postblast.findInspection(db, request.params.blastId),
      misfires: postblast.listMisfires(db, request.params.blastId),
      diggability: postblast.diggability(db, request.params.blastId),
    }),
  );

  app.post(
    '/blasts/:blastId/misfires',
    { preHandler: app.requireGrant('fire'), schema: { body: misfireBody } },
    async (request, reply) =>
      reply.code(201).send({
        misfire: postblast.recordMisfire(
          db,
          {
            ...request.body,
            blastId: request.params.blastId,
            discoveredAt: request.body.discoveredAt ?? clock.now(),
            discoveredBy: request.actor.id,
          },
          { clock, actorId: request.actor.id },
        ),
      }),
  );

  app.post(
    '/misfires/:misfireId/made-safe',
    { preHandler: app.requireGrant('fire') },
    async (request) => ({
      misfire: postblast.markMisfireSafe(db, request.params.misfireId, {
        clock,
        personId: request.actor.id,
      }),
    }),
  );

  app.get(
    '/sites/:siteId/inspections',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      inspections: postblast.listInspections(db, request.params.siteId, {
        from: request.query.from,
        to: request.query.to,
      }),
    }),
  );

  app.post(
    '/blasts/:blastId/notifications',
    {
      preHandler: app.requireGrant('clearance'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            plannedFor: { type: 'string' },
            radiusM: { type: 'number', exclusiveMinimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const blast = blasts.getBlast(db, request.params.blastId);
      const holes = blast.patternId
        ? patterns.listHoles(db, blast.patternId).map((hole) => ({
            holeNumber: hole.holeNumber,
            easting: hole.eastingM,
            northing: hole.northingM,
            collarLevelM: hole.collarLevelM,
          }))
        : [{ holeNumber: 1, easting: 0, northing: 0, collarLevelM: 0 }];
      const list = buildList({
        blastId: blast.id,
        receptors: monitoring.listReceptors(db, blast.siteId),
        holes,
        plannedFor: request.body?.plannedFor ?? blast.plannedFor ?? clock.now(),
        ...(request.body?.radiusM
          ? { rules: { radiusM: request.body.radiusM, channelsInOrder: ['text_message'] } }
          : {}),
      });
      const written = community.planNotifications(db, blast.id, list, { clock });
      return reply.code(201).send({ notifications: written, count: written.length });
    },
  );

  app.get(
    '/blasts/:blastId/notifications',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      notifications: community.listNotifications(db, request.params.blastId),
      summary: community.notificationSummary(db, request.params.blastId),
    }),
  );

  app.post(
    '/notifications/:notificationId/outcome',
    {
      preHandler: app.requireGrant('clearance'),
      schema: {
        body: {
          type: 'object',
          required: ['sent'],
          additionalProperties: false,
          properties: { sent: { type: 'boolean' }, reason: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (request) => ({
      notification: community.recordNotificationOutcome(
        db,
        request.params.notificationId,
        { sent: request.body.sent, reason: request.body.reason },
        { clock },
      ),
    }),
  );

  return app;
}
