/**
 * Comparing two designs for the same rock.
 *
 * The question a designer actually has is never "is this design good", it is
 * "is this one better than the one we fired last time, and better how". Better
 * is four numbers pulling against each other: a tighter pattern breaks smaller
 * and costs more to drill, a bigger charge per hole breaks better and shakes the
 * cottage harder, and a longer delay between holes lowers the vibration and
 * lengthens the shot.
 *
 * So this reports all four side by side and refuses to produce a single score.
 * A single score would be a weighting nobody agreed, and it would hide the one
 * dimension that matters on the day.
 */

import { roundTo } from '../lib/units.js';
import { ValidationError } from '../lib/errors.js';
import { layoutPattern, summarisePattern } from '../domain/geometry/pattern.js';
import { planPattern } from '../domain/charging/charge-plan.js';
import { resolveFiringTimes } from '../domain/initiation/tie-in.js';
import { summariseTiming } from '../domain/initiation/windows.js';
import { predict as predictFragmentation } from '../domain/postblast/fragmentation.js';
import { predictPeakParticleVelocity } from '../domain/vibration/site-law.js';
import { costBlast } from '../domain/costing/blast-cost.js';

function serpentineTieIn(holeCount, delayMs, inHoleDelayMs = 500) {
  return {
    initiationHole: 1,
    holes: Array.from({ length: holeCount }, (_unused, index) => ({
      holeNumber: index + 1,
      inHoleDelayMs,
    })),
    connectors: Array.from({ length: Math.max(holeCount - 1, 0) }, (_unused, index) => ({
      fromHole: index + 1,
      toHole: index + 2,
      delayMs,
    })),
  };
}

/** Work one design out end to end, without writing anything down. */
export function evaluateDesign({
  design,
  catalogue,
  powderFactorKgM3,
  connectorDelayMs = 42,
  law,
  receptorDistanceM,
  frequencyHz = null,
  prices = [],
  rates = [],
  onDate,
  rockFactorA = 7,
  oversizeCm = 80,
  rockDensityKgM3 = 2700,
}) {
  const laid = layoutPattern(design);
  const shape = summarisePattern(design, laid.holes);
  const holes = laid.holes.map((hole) => ({
    ...hole,
    condition: 'dry',
    drilledDepthM: hole.designedDepthM,
    nominalBurdenM: design.burdenM,
    measuredBurdenM: design.burdenM,
  }));
  const plan = planPattern(holes, {
    catalogue,
    burdenM: design.burdenM,
    spacingM: design.spacingM,
    benchHeightM: design.benchHeightM,
    powderFactorKgM3,
  });
  const resolved = resolveFiringTimes(serpentineTieIn(holes.length, connectorDelayMs));
  const timing = summariseTiming(
    resolved,
    new Map(plan.holes.map((item) => [item.holeNumber, item.loadedMassKg])),
  );
  const perHoleKg = plan.holes.length > 0 ? plan.totalMassKg / plan.holes.length : 0;
  const fragmentation = predictFragmentation({
    rockFactorA,
    volumeM3: shape.volumePerHoleM3,
    chargeKg: Math.max(perHoleKg, 0.1),
    burdenM: design.burdenM,
    spacingM: design.spacingM,
    diameterMm: design.diameterMm,
    chargeLengthM: Math.max(plan.holes[0]?.column.chargeLengthM ?? 1, 0.5),
    benchHeightM: design.benchHeightM,
    oversizeCm,
  });
  const predictedPpv =
    law && receptorDistanceM
      ? predictPeakParticleVelocity({
          k: law.k,
          b: law.b,
          distanceM: receptorDistanceM,
          chargeKg: Math.max(timing.maximumInstantaneousChargeKg, 0.1),
          scaling: law.scaling,
        })
      : null;
  const tonnes = roundTo((shape.volumeM3 * rockDensityKgM3) / 1000, 2);
  const cost = costBlast({
    consumption: Object.entries(plan.byProduct).map(([productCode, quantity]) => ({
      productCode,
      quantity,
      unit: 'kg',
    })),
    prices,
    rates,
    metresDrilled: shape.totalDrillingM,
    tonnes,
    volumeM3: shape.volumeM3,
    onDate,
  });

  return {
    shape,
    holeCount: holes.length,
    totalChargeKg: plan.totalMassKg,
    powderFactorKgM3: plan.achievedPowderFactorKgM3,
    instantaneousChargeKg: timing.maximumInstantaneousChargeKg,
    durationMs: timing.durationMs,
    predictedPpvMmPerSecond: predictedPpv,
    fragmentation: {
      meanCm: fragmentation.meanCm,
      p80Cm: fragmentation.p80Cm,
      oversizeFraction: fragmentation.oversizeFraction,
    },
    tonnes,
    cost: { total: cost.total, perTonne: cost.perTonne, parts: cost.parts },
    frequencyHz,
    violations: plan.violations,
  };
}

export function createComparisonService({ clock }) {
  /** Two designs, side by side, with the differences worked out. */
  function compare({ base, alternative, ...shared }) {
    if (!base || !alternative) {
      throw new ValidationError('a comparison needs two designs', [
        {
          path: 'alternative',
          message: 'give a second design to compare against',
          kind: 'missing',
        },
      ]);
    }
    const onDate = shared.onDate ?? clock.date();
    const first = evaluateDesign({ ...shared, design: base, onDate });
    const second = evaluateDesign({ ...shared, design: alternative, onDate });

    const difference = (key, reader) => {
      const from = reader(first);
      const to = reader(second);
      if (from === null || to === null || from === undefined || to === undefined) {
        return { key, from, to, change: null, percent: null };
      }
      return {
        key,
        from,
        to,
        change: roundTo(to - from, 4),
        percent: from === 0 ? null : roundTo(((to - from) / from) * 100, 2),
      };
    };

    return {
      base: first,
      alternative: second,
      differences: [
        difference('holeCount', (design) => design.holeCount),
        difference('drillingMetres', (design) => design.shape.totalDrillingM),
        difference('totalChargeKg', (design) => design.totalChargeKg),
        difference('instantaneousChargeKg', (design) => design.instantaneousChargeKg),
        difference('predictedPpv', (design) => design.predictedPpvMmPerSecond),
        difference('meanFragmentCm', (design) => design.fragmentation.meanCm),
        difference('oversizeFraction', (design) => design.fragmentation.oversizeFraction),
        difference('costPerTonne', (design) => design.cost.perTonne),
      ],
      // Deliberately not a score. Each of these is a direction, and a design that
      // wins on three and loses badly on the fourth is not obviously better.
      verdict: {
        quieter: verdictOn(first.predictedPpvMmPerSecond, second.predictedPpvMmPerSecond),
        finer: verdictOn(first.fragmentation.meanCm, second.fragmentation.meanCm),
        cheaper: verdictOn(first.cost.perTonne, second.cost.perTonne),
        lessOversize: verdictOn(
          first.fragmentation.oversizeFraction,
          second.fragmentation.oversizeFraction,
        ),
      },
    };
  }

  return { compare, evaluateDesign };
}

function verdictOn(from, to) {
  if (from === null || to === null || from === undefined || to === undefined) {
    return 'unknown';
  }
  if (roundTo(to, 6) === roundTo(from, 6)) {
    return 'the same';
  }
  return to < from ? 'alternative' : 'base';
}
