/**
 * Designing a shot over HTTP.
 *
 * These routes compute and return; they do not save. A designer moves the powder
 * factor up and down a dozen times before anything is committed, and writing a
 * load sheet on every one of those would fill the database with drafts nobody
 * asked for. The committing route is the one that writes the decks, and it is
 * separate and explicit.
 */

import { createDesignService } from '../../services/design.service.js';
import * as explosives from '../../db/repositories/explosives.js';
import * as patterns from '../../db/repositories/patterns.js';
import * as blasts from '../../db/repositories/blasts.js';
import { parseProduct } from '../../domain/charging/products.js';
import { predict } from '../../domain/postblast/fragmentation.js';
import { ValidationError } from '../../lib/errors.js';
import { createComparisonService } from '../../services/comparison.service.js';
import * as monitoring from '../../db/repositories/monitoring.js';
import * as costing from '../../db/repositories/costing.js';
import { designShape, tieInSchema } from '../schemas.js';

export function designRoutes(app) {
  const { db, clock, logger } = app.deps;
  const context = { clock };
  const service = createDesignService({ db, clock, logger });
  const comparison = createComparisonService({ clock });

  /** The catalogue the designer may load from, read out of the database. */
  function catalogueFor() {
    return explosives
      .listProducts(db)
      .filter((product) =>
        ['bulk_anfo', 'bulk_emulsion', 'bulk_blend', 'packaged_emulsion'].includes(product.kind),
      )
      .map((product) =>
        parseProduct({
          code: product.code,
          name: product.name,
          kind: product.kind,
          densityKgM3: product.densityKgM3,
          relativeWeightStrength: product.relativeWeightStrength,
          velocityOfDetonationMs: product.velocityOfDetonationMs,
          waterResistance: product.waterResistance,
          minimumDiameterMm: product.minimumDiameterMm,
          sleepTimeHours: product.sleepTimeHours,
        }),
      );
  }

  app.post(
    '/patterns/:patternId/charge-plan',
    {
      preHandler: app.requireGrant('design'),
      schema: {
        body: {
          type: 'object',
          required: ['powderFactorKgM3'],
          additionalProperties: false,
          properties: {
            powderFactorKgM3: { type: 'number', exclusiveMinimum: 0, maximum: 3 },
            stemmingM: { type: 'number', minimum: 0, maximum: 20 },
          },
        },
      },
    },
    async (request) => {
      const catalogue = catalogueFor();
      if (catalogue.length === 0) {
        throw new ValidationError('there is nothing in the product catalogue to load with', [
          { path: 'catalogue', message: 'add a bulk product first', kind: 'missing' },
        ]);
      }
      const result = service.planCharges({
        patternId: request.params.patternId,
        catalogue,
        powderFactorKgM3: request.body.powderFactorKgM3,
        stemmingM: request.body.stemmingM,
      });
      return {
        totals: {
          holeCount: result.plan.holes.length,
          totalMassKg: result.plan.totalMassKg,
          byProduct: result.plan.byProduct,
          achievedPowderFactorKgM3: result.plan.achievedPowderFactorKgM3,
          shortfallKg: result.plan.shortfallKg,
        },
        sheet: result.sheet,
        violations: result.checks.violations,
        skipped: result.plan.skipped,
      };
    },
  );

  app.post(
    '/patterns/:patternId/timing',
    {
      preHandler: app.requireGrant('design'),
      schema: {
        body: {
          type: 'object',
          required: ['powderFactorKgM3', 'tieIn'],
          additionalProperties: false,
          properties: {
            powderFactorKgM3: { type: 'number', exclusiveMinimum: 0, maximum: 3 },
            stemmingM: { type: 'number', minimum: 0 },
            tieIn: tieInSchema,
            windowMs: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
          },
        },
      },
    },
    async (request) => {
      const charging = service.planCharges({
        patternId: request.params.patternId,
        catalogue: catalogueFor(),
        powderFactorKgM3: request.body.powderFactorKgM3,
        stemmingM: request.body.stemmingM,
      });
      const timing = service.planTiming({
        patternId: request.params.patternId,
        plan: charging.plan,
        tieIn: request.body.tieIn,
        windowMs: request.body.windowMs ?? 8,
      });
      return {
        firingOrder: timing.resolved.holes,
        summary: {
          maximumInstantaneousChargeKg: timing.timing.maximumInstantaneousChargeKg,
          totalMassKg: timing.timing.totalMassKg,
          durationMs: timing.timing.durationMs,
          windowCount: timing.timing.windowCount,
        },
        violations: timing.checks.violations,
      };
    },
  );

  app.post(
    '/sites/:siteId/patterns/:patternId/design',
    {
      preHandler: app.requireGrant('design'),
      schema: {
        body: {
          type: 'object',
          required: ['powderFactorKgM3', 'tieIn'],
          additionalProperties: false,
          properties: {
            powderFactorKgM3: { type: 'number', exclusiveMinimum: 0, maximum: 3 },
            stemmingM: { type: 'number', minimum: 0 },
            tieIn: tieInSchema,
            frequencyHz: { type: 'number', exclusiveMinimum: 0 },
            blastId: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      const result = service.design({
        siteId: request.params.siteId,
        patternId: request.params.patternId,
        catalogue: catalogueFor(),
        powderFactorKgM3: request.body.powderFactorKgM3,
        stemmingM: request.body.stemmingM,
        tieIn: request.body.tieIn,
        frequencyHz: request.body.frequencyHz,
      });
      const pattern = patterns.getPattern(db, request.params.patternId);
      const fragmentation = predict({
        rockFactorA: 7,
        volumeM3: pattern.nominalBurdenM * pattern.nominalSpacingM * pattern.benchHeightM,
        chargeKg: Math.max(result.totals.totalChargeKg / Math.max(result.totals.holeCount, 1), 0.1),
        burdenM: pattern.nominalBurdenM,
        spacingM: pattern.nominalSpacingM,
        diameterMm: pattern.holeDiameterMm,
        chargeLengthM: Math.max(pattern.benchHeightM - 3, 1),
        benchHeightM: pattern.benchHeightM,
        oversizeCm: 80,
      });
      if (request.body.blastId) {
        blasts.recordDesignTotals(db, request.body.blastId, result.totals, context);
      }
      return {
        totals: result.totals,
        vibration: {
          law: result.vibration.law,
          worst: result.vibration.assessment.worst,
          compliant: result.vibration.assessment.compliant,
          binding: result.vibration.allowances.binding,
          reduction: result.vibration.reduction,
        },
        fragmentation: {
          meanCm: fragmentation.meanCm,
          uniformity: fragmentation.uniformity,
          oversizeFraction: fragmentation.oversizeFraction,
        },
        violations: result.violations,
      };
    },
  );

  app.post(
    '/sites/:siteId/what-if',
    {
      preHandler: app.requireGrant('design'),
      schema: {
        body: {
          type: 'object',
          required: ['base', 'alternative', 'powderFactorKgM3'],
          additionalProperties: false,
          properties: {
            base: designShape,
            alternative: designShape,
            powderFactorKgM3: { type: 'number', exclusiveMinimum: 0, maximum: 3 },
            connectorDelayMs: { type: 'number', minimum: 0, maximum: 1000 },
            receptorDistanceM: { type: 'number', exclusiveMinimum: 0 },
            rockFactorA: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
          },
        },
      },
    },
    async (request) => {
      const siteId = request.params.siteId;
      const law = monitoring.currentSiteLaw(db, siteId);
      const receptors = monitoring.listReceptors(db, siteId);
      return comparison.compare({
        base: request.body.base,
        alternative: request.body.alternative,
        catalogue: catalogueFor(),
        powderFactorKgM3: request.body.powderFactorKgM3,
        connectorDelayMs: request.body.connectorDelayMs ?? 42,
        law: law ?? undefined,
        receptorDistanceM: request.body.receptorDistanceM ?? (receptors.length > 0 ? 400 : null),
        rockFactorA: request.body.rockFactorA ?? 7,
        prices: costing.priceBook(db),
        rates: costing.rateBook(db, siteId),
      });
    },
  );

  return app;
}
