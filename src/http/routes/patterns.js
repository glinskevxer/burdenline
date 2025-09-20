/**
 * Patterns, holes and the drill log.
 *
 * The drill log arrives as the text of a csv file rather than as json, because
 * what actually happens is that somebody exports it off the rig and pastes it
 * in. Taking it as text and parsing it here means the same code path serves the
 * upload, the command line tool and whatever the rig integration turns into.
 */

import * as patterns from '../../db/repositories/patterns.js';
import * as sites from '../../db/repositories/sites.js';
import { layoutPattern, summarisePattern } from '../../domain/geometry/pattern.js';
import { parseDrillLog, reconcileDrilling } from '../../domain/drilling/log-ingest.js';
import { exportDrillPlan, planSummary } from '../../domain/drilling/plan-export.js';

const layoutBody = {
  type: 'object',
  required: [
    'reference',
    'faceBearingDeg',
    'rowCount',
    'holesPerRow',
    'burdenM',
    'spacingM',
    'diameterMm',
    'origin',
  ],
  additionalProperties: false,
  properties: {
    reference: { type: 'string', minLength: 3, maxLength: 40 },
    origin: {
      type: 'object',
      required: ['easting', 'northing', 'level'],
      additionalProperties: false,
      properties: {
        easting: { type: 'number' },
        northing: { type: 'number' },
        level: { type: 'number' },
      },
    },
    faceBearingDeg: { type: 'number', minimum: 0, exclusiveMaximum: 360 },
    layout: { type: 'string', enum: ['square', 'staggered', 'single_row'] },
    rowCount: { type: 'integer', minimum: 1, maximum: 20 },
    holesPerRow: { type: 'integer', minimum: 1, maximum: 200 },
    burdenM: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
    spacingM: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
    benchHeightM: { type: 'number', exclusiveMinimum: 0, maximum: 60 },
    subdrillM: { type: 'number', minimum: 0, maximum: 6 },
    inclinationDeg: { type: 'number', minimum: 0, maximum: 45 },
    diameterMm: { type: 'number', minimum: 25, maximum: 400 },
    designedBy: { type: 'string' },
  },
};

export function patternRoutes(app) {
  const { db, clock } = app.deps;
  const context = { clock };

  app.post(
    '/benches/:benchId/patterns',
    { preHandler: app.requireGrant('design'), schema: { body: layoutBody } },
    async (request, reply) => {
      const bench = sites.getBench(db, request.params.benchId);
      const benchHeightM = request.body.benchHeightM ?? sites.benchHeightM(bench);
      const design = { ...request.body, benchHeightM };
      const laid = layoutPattern(design);
      const pattern = patterns.createPattern(
        db,
        {
          benchId: bench.id,
          reference: request.body.reference,
          layout: design.layout ?? 'staggered',
          holeDiameterMm: design.diameterMm,
          nominalBurdenM: design.burdenM,
          nominalSpacingM: design.spacingM,
          rowCount: design.rowCount,
          holesPerRow: design.holesPerRow,
          benchHeightM,
          subdrillM: design.subdrillM ?? 0,
          inclinationDeg: design.inclinationDeg ?? 0,
          bearingDeg: design.faceBearingDeg,
          designedBy: design.designedBy ?? request.actor.id,
        },
        context,
      );
      patterns.replaceHoles(db, pattern.id, laid.holes, context);
      return reply.code(201).send({
        pattern,
        summary: summarisePattern(design, laid.holes),
        holeCount: laid.holes.length,
      });
    },
  );

  app.get(
    '/benches/:benchId/patterns',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      patterns: patterns.listPatterns(db, request.params.benchId, { status: request.query.status }),
    }),
  );

  app.get('/patterns/:patternId', { preHandler: app.requireGrant('read') }, async (request) => {
    const pattern = patterns.getPattern(db, request.params.patternId);
    const holes = patterns.listHoles(db, pattern.id);
    return { pattern, holes, holeCount: holes.length };
  });

  app.get(
    '/patterns/:patternId/plan.csv',
    { preHandler: app.requireGrant('read') },
    async (request, reply) => {
      const pattern = patterns.getPattern(db, request.params.patternId);
      const holes = patterns.listHoles(db, pattern.id).map((hole) => ({
        ...hole,
        easting: hole.eastingM,
        northing: hole.northingM,
      }));
      const csv = exportDrillPlan(pattern, holes, { format: request.query.format ?? 'collar' });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${pattern.reference}.csv"`)
        .send(csv);
    },
  );

  app.get(
    '/patterns/:patternId/plan',
    { preHandler: app.requireGrant('read') },
    async (request) => {
      const pattern = patterns.getPattern(db, request.params.patternId);
      const holes = patterns.listHoles(db, pattern.id).map((hole) => ({
        ...hole,
        easting: hole.eastingM,
        northing: hole.northingM,
      }));
      return { summary: planSummary(pattern, holes) };
    },
  );

  app.post(
    '/patterns/:patternId/drill-log',
    {
      preHandler: app.requireGrant('design'),
      schema: {
        body: {
          type: 'object',
          required: ['csv'],
          additionalProperties: false,
          properties: {
            csv: { type: 'string', minLength: 1 },
            skipLines: { type: 'integer', minimum: 0, maximum: 50 },
          },
        },
      },
    },
    async (request) => {
      const pattern = patterns.getPattern(db, request.params.patternId);
      const rows = parseDrillLog(request.body.csv, { skipLines: request.body.skipLines ?? 0 });
      const designed = patterns.listHoles(db, pattern.id).map((hole) => ({
        holeNumber: hole.holeNumber,
        designedDepthM: hole.designedDepthM,
      }));
      const reconciliation = reconcileDrilling(designed, rows);
      const written = patterns.recordDrilling(db, pattern.id, rows, context);
      return { reconciliation, written };
    },
  );

  app.get(
    '/patterns/:patternId/holes',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      holes: patterns.listHoles(db, request.params.patternId, {
        limit: Number(request.query.limit ?? 1000),
        offset: Number(request.query.offset ?? 0),
      }),
      total: patterns.holeCount(db, request.params.patternId),
    }),
  );

  return app;
}
