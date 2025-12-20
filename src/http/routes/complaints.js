/**
 * Complaints over HTTP.
 *
 * The route that records one is deliberately generous about what it needs: a
 * complaint is taken down while somebody is on the telephone and being made to
 * fill in a receptor and a shot reference before the record exists is how
 * complaints end up on a sticky note instead. Everything except the site, the
 * channel, what it is about and what was said can be added afterwards.
 */

import * as community from '../../db/repositories/community.js';
import * as blasts from '../../db/repositories/blasts.js';
import * as monitoring from '../../db/repositories/monitoring.js';
import { matchToBlasts, supportingRecords } from '../../domain/community/complaints.js';

const complaintBody = {
  type: 'object',
  required: ['channel', 'about', 'description'],
  additionalProperties: false,
  properties: {
    receptorId: { type: 'string' },
    blastId: { type: 'string' },
    receivedAt: { type: 'string' },
    channel: {
      type: 'string',
      enum: ['telephone', 'email', 'letter', 'in_person', 'regulator', 'other'],
    },
    complainant: { type: 'string', maxLength: 120 },
    contact: { type: 'string', maxLength: 120 },
    about: {
      type: 'string',
      enum: ['vibration', 'airblast', 'dust', 'noise', 'flyrock', 'traffic', 'other'],
    },
    description: { type: 'string', minLength: 5, maxLength: 2000 },
    occurredAt: { type: 'string' },
  },
};

const outcomeBody = {
  type: 'object',
  additionalProperties: false,
  properties: { outcome: { type: 'string', minLength: 5, maxLength: 1000 } },
};

export function complaintRoutes(app) {
  const { db, clock } = app.deps;

  app.post(
    '/sites/:siteId/complaints',
    { preHandler: app.requireGrant('read'), schema: { body: complaintBody } },
    async (request, reply) =>
      reply.code(201).send({
        complaint: community.recordComplaint(
          db,
          {
            ...request.body,
            siteId: request.params.siteId,
            receivedAt: request.body.receivedAt ?? clock.now(),
          },
          { clock, actorId: request.actor.id },
        ),
      }),
  );

  app.get('/sites/:siteId/complaints', { preHandler: app.requireGrant('read') }, async (request) =>
    community.complaintOverview(db, request.params.siteId, {
      state: request.query.state,
      from: request.query.from,
      to: request.query.to,
      asOf: clock.now(),
    }),
  );

  app.get('/complaints/:complaintId', { preHandler: app.requireGrant('read') }, async (request) => {
    const complaint = community.getComplaint(db, request.params.complaintId);
    const candidates = blasts
      .listBlasts(db, complaint.siteId, { pageSize: 100 })
      .filter((blast) => blast.firedAt);
    const records = monitoring.listRecords(db, complaint.siteId, { limit: 200 });
    return {
      complaint,
      clock: community.complaintClock(db, complaint.id, clock.now()),
      match: matchToBlasts(complaint, candidates),
      supporting: supportingRecords(complaint, records).slice(0, 10),
    };
  });

  // Only the moves that have to say something carry a body schema. A route that
  // demands a body is a route that answers 422 to a plain button press, which is
  // what investigate and close actually are.
  for (const [path, action, needsOutcome] of [
    ['investigate', 'investigate', false],
    ['respond', 'respond', true],
    ['close', 'close', false],
    ['withdraw', 'withdraw', true],
    ['reopen', 'reopen', true],
  ]) {
    app.post(
      `/complaints/:complaintId/${path}`,
      {
        preHandler: app.requireGrant('read'),
        ...(needsOutcome ? { schema: { body: outcomeBody } } : {}),
      },
      async (request) => ({
        complaint: community.advanceComplaint(
          db,
          request.params.complaintId,
          action,
          { outcome: request.body?.outcome },
          { clock, actorId: request.actor.id },
        ),
      }),
    );
  }

  app.post(
    '/complaints/:complaintId/blast',
    {
      preHandler: app.requireGrant('read'),
      schema: {
        body: {
          type: 'object',
          required: ['blastId'],
          additionalProperties: false,
          properties: { blastId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request) => {
      const complaint = community.getComplaint(db, request.params.complaintId);
      blasts.getBlast(db, request.body.blastId);
      db.prepare('UPDATE complaint SET blast_id = ?, updated_at = ? WHERE id = ?').run(
        request.body.blastId,
        clock.now(),
        complaint.id,
      );
      return { complaint: community.getComplaint(db, complaint.id) };
    },
  );

  return app;
}
