/**
 * The clearance and the firing button.
 *
 * The gate route and the fire route take the same inputs, and that is on
 * purpose: the screen asks the gate every few seconds while the crew work
 * through the list, and then fires with exactly what it was showing. The gate is
 * asked again inside the firing transaction, so the two cannot come apart.
 */

import { createFiringService } from '../../services/firing.service.js';
import { parseSchedule } from '../../domain/firing/firing-windows.js';
import { parsePerson, parseCertificate } from '../../domain/people/competency.js';
import { rowsToObjects } from '../../db/repository.js';

const observationSchema = {
  type: 'object',
  required: ['windSpeedMs', 'windBearingDeg', 'temperatureC'],
  additionalProperties: false,
  properties: {
    observedAt: { type: 'string' },
    windSpeedMs: { type: 'number', minimum: 0, maximum: 60 },
    windBearingDeg: { type: 'number', minimum: 0, exclusiveMaximum: 360 },
    temperatureC: { type: 'number', minimum: -40, maximum: 55 },
    temperatureAt10mC: { type: 'number', minimum: -40, maximum: 55 },
    visibilityM: { type: 'number', minimum: 0 },
    cloudBaseM: { type: 'number', minimum: 0 },
    lightningDistanceKm: { type: 'number', minimum: 0 },
    rainfallMmPerHour: { type: 'number', minimum: 0 },
    observedBy: { type: 'string' },
  },
};

const gateBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    observation: observationSchema,
    schedule: { type: 'object' },
    embargoes: { type: 'array', items: { type: 'object' } },
    wetHoles: { type: 'boolean' },
    overrides: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rule', 'reason'],
        additionalProperties: false,
        properties: {
          rule: { type: 'string' },
          reason: { type: 'string', minLength: 10 },
          holeNumber: { type: 'integer' },
          receptorId: { type: 'string' },
        },
      },
    },
  },
};

export function firingRoutes(app) {
  const { db, clock, logger } = app.deps;
  const service = createFiringService({ db, clock, logger });

  /** The person firing, and their certificates, read off the token. */
  function actorCompetency(request) {
    const row = db
      .prepare('SELECT id, name, roles, active FROM person WHERE id = ?')
      .get(request.actor.id);
    if (!row) {
      return { person: null, certificates: [] };
    }
    const person = parsePerson({
      id: row.id,
      name: row.name,
      roles: String(row.roles)
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean),
      active: row.active === 1,
    });
    const certificates = rowsToObjects(
      db.prepare('SELECT * FROM certificate WHERE person_id = ?').all(row.id),
    ).map((certificate) =>
      parseCertificate({
        id: certificate.id,
        personId: certificate.personId,
        kind: certificate.kind,
        reference: certificate.reference,
        issuedOn: certificate.issuedOn,
        expiresOn: certificate.expiresOn,
        endorsements: certificate.endorsements ? certificate.endorsements.split(',') : [],
        suspended: certificate.suspended === 1,
      }),
    );
    return { person, certificates };
  }

  function gateInputsFrom(request) {
    const body = request.body ?? {};
    const { person, certificates } = actorCompetency(request);
    return {
      observation: body.observation,
      schedule: body.schedule ? parseSchedule(body.schedule) : undefined,
      embargoes: body.embargoes ?? [],
      wetHoles: body.wetHoles ?? false,
      overrides: (body.overrides ?? []).map((override) => ({ ...override, by: request.actor.id })),
      person,
      certificates,
      zone: app.deps.config?.site?.zone ?? 'UTC',
    };
  }

  app.post(
    '/blasts/:blastId/clearance',
    { preHandler: app.requireGrant('clearance') },
    async (request, reply) =>
      reply
        .code(201)
        .send({ clearance: service.startClearance({ blastId: request.params.blastId }) }),
  );

  app.get(
    '/blasts/:blastId/clearance',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      clearance: service.readClearance(request.params.blastId),
      state: service.clearanceState({ blastId: request.params.blastId }),
    }),
  );

  app.post(
    '/blasts/:blastId/clearance/:itemKey',
    {
      preHandler: app.requireGrant('clearance'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { note: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (request) =>
      service.completeItem({
        blastId: request.params.blastId,
        itemKey: request.params.itemKey,
        by: request.actor.id,
        note: request.body?.note ?? null,
      }),
  );

  app.post(
    '/blasts/:blastId/gate',
    { preHandler: app.requireGrant('read'), schema: { body: gateBody } },
    async (request) =>
      service.gate({ blastId: request.params.blastId, ...gateInputsFrom(request) }),
  );

  app.post(
    '/blasts/:blastId/fire',
    { preHandler: app.requireGrant('fire'), schema: { body: gateBody } },
    async (request) =>
      service.fire({
        blastId: request.params.blastId,
        shotfirerId: request.actor.id,
        gateInputs: gateInputsFrom(request),
      }),
  );

  app.post(
    '/blasts/:blastId/misfire',
    {
      preHandler: app.requireGrant('fire'),
      schema: {
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 5, maxLength: 1000 } },
        },
      },
    },
    async (request) =>
      service.reportMisfire({
        blastId: request.params.blastId,
        reason: request.body.reason,
        actorId: request.actor.id,
      }),
  );

  app.post(
    '/blasts/:blastId/made-safe',
    {
      preHandler: app.requireGrant('fire'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { note: { type: 'string', maxLength: 1000 } },
        },
      },
    },
    async (request) =>
      service.makeSafe({
        blastId: request.params.blastId,
        shotfirerId: request.actor.id,
        note: request.body?.note,
      }),
  );

  return app;
}
