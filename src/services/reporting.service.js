/**
 * The numbers somebody asks for at the end of the month.
 *
 * Two shapes. A shot report is everything known about one blast gathered from
 * six tables, which is what gets printed and filed. A period report is the same
 * information rolled up: how much rock, at what powder factor, for what cost,
 * with how many exceedances and complaints against it.
 *
 * Nothing here computes a rule. Every number comes from the domain modules that
 * own it, and this reads and arranges. That is why a report can never disagree
 * with the screen the designer was looking at.
 */

import { roundTo } from '../lib/units.js';
import { NotFoundError } from '../lib/errors.js';
import { costBlast } from '../domain/costing/blast-cost.js';
import { trend } from '../domain/postblast/inspection.js';
import { summarise as summariseComplaints } from '../domain/community/complaints.js';
import { complianceSummary, evaluateAll } from '../domain/monitoring/compliance.js';
import * as blasts from '../db/repositories/blasts.js';
import * as patterns from '../db/repositories/patterns.js';
import * as monitoring from '../db/repositories/monitoring.js';
import * as explosives from '../db/repositories/explosives.js';
import * as postblast from '../db/repositories/postblast.js';
import * as community from '../db/repositories/community.js';
import * as costing from '../db/repositories/costing.js';

export function createReportingService({ db, clock }) {
  function consumptionFor(blastId) {
    const lines = explosives
      .ledgerForBlast(db, blastId)
      .filter((line) => line.movement === 'consumption');
    const byProduct = new Map();
    for (const line of lines) {
      const current = byProduct.get(line.productCode) ?? {
        productCode: line.productCode,
        quantity: 0,
        unit: line.unit,
      };
      current.quantity = roundTo(current.quantity + Math.abs(line.quantity), 3);
      byProduct.set(line.productCode, current);
    }
    return [...byProduct.values()];
  }

  function metresDrilledFor(patternId) {
    if (!patternId) {
      return 0;
    }
    return roundTo(
      patterns
        .listHoles(db, patternId)
        .reduce((sum, hole) => sum + (hole.drilledDepthM ?? hole.designedDepthM ?? 0), 0),
      2,
    );
  }

  /** Everything known about one shot. */
  function blastReport({ blastId, labourHours = 0, secondaryBreakingHours = 0 }) {
    const blast = blasts.findBlast(db, blastId);
    if (!blast) {
      throw new NotFoundError('blast', blastId);
    }
    const onDate = (blast.firedAt ?? clock.now()).slice(0, 10);
    const consumption = consumptionFor(blast.id);
    const metresDrilled = metresDrilledFor(blast.patternId);
    const tonnes = blast.volumeM3 ? roundTo(blast.volumeM3 * 2.7, 2) : null;
    const cost = costBlast({
      consumption,
      prices: costing.priceBook(db),
      rates: costing.rateBook(db, blast.siteId),
      metresDrilled,
      labourHours,
      secondaryBreakingHours,
      tonnes,
      volumeM3: blast.volumeM3,
      onDate,
    });
    const records = monitoring.listRecords(db, blast.siteId, { blastId: blast.id });
    const receptors = new Map(monitoring.listReceptors(db, blast.siteId).map((r) => [r.id, r]));
    const { results } = evaluateAll(records, receptors);

    return {
      blast,
      events: blasts.eventsFor(db, blast.id),
      inspection: postblast.findInspection(db, blast.id),
      misfires: postblast.listMisfires(db, blast.id),
      notifications: community.notificationSummary(db, blast.id),
      consumption,
      metresDrilled,
      cost,
      monitoring: { records: results, summary: complianceSummary(results) },
      diggable: postblast.diggability(db, blast.id).diggable,
    };
  }

  /** The month, or whatever period was asked for. */
  function periodReport({ siteId, from, to, rockDensityKgM3 = 2700 }) {
    const fired = blasts
      .listBlasts(db, siteId, { pageSize: 200 })
      .filter((blast) => blast.firedAt && blast.firedAt >= from && blast.firedAt <= to);

    const volumeM3 = roundTo(
      fired.reduce((sum, blast) => sum + (blast.volumeM3 ?? 0), 0),
      2,
    );
    const chargeKg = roundTo(
      fired.reduce((sum, blast) => sum + (blast.totalChargeKg ?? 0), 0),
      2,
    );
    const metresDrilled = roundTo(
      fired.reduce((sum, blast) => sum + metresDrilledFor(blast.patternId), 0),
      2,
    );
    const costs = fired.map((blast) => blastReport({ blastId: blast.id }).cost);
    const totalCost = roundTo(
      costs.reduce((sum, cost) => sum + cost.total, 0),
      2,
    );
    const tonnes = roundTo((volumeM3 * rockDensityKgM3) / 1000, 2);

    const records = monitoring.listRecords(db, siteId, { from, to, limit: 2000 });
    const receptors = new Map(monitoring.listReceptors(db, siteId).map((r) => [r.id, r]));
    const { results } = evaluateAll(records, receptors);
    const inspections = postblast.listInspections(db, siteId, { from, to }).map((row) => ({
      blastId: row.blastId,
      muckpileShape: row.muckpileShape,
      throwM: row.throwM,
      toeGrade: row.toeGrade,
      backbreakM: row.backbreakM,
      oversizeCount: row.oversizeCount,
      flyrockObserved: row.flyrockObserved === 1,
      faceStable: row.faceStable === 1,
      fumeGrade: row.fumeGrade,
    }));
    const complaints = community.listComplaints(db, siteId, { from, to, limit: 500 });

    return {
      siteId,
      from,
      to,
      blastCount: fired.length,
      volumeM3,
      tonnes,
      chargeKg,
      metresDrilled,
      powderFactorKgM3: volumeM3 > 0 ? roundTo(chargeKg / volumeM3, 4) : null,
      drillingMetresPerTonne: tonnes > 0 ? roundTo(metresDrilled / tonnes, 5) : null,
      cost: {
        total: totalCost,
        perTonne: tonnes > 0 ? roundTo(totalCost / tonnes, 4) : null,
        perBlast: fired.length > 0 ? roundTo(totalCost / fired.length, 2) : null,
      },
      monitoring: complianceSummary(results),
      inspections: trend(inspections, { holeCount: 24 }),
      complaints: summariseComplaints(complaints, clock.now()),
    };
  }

  /** The one line a manager wants: are we inside everything we said we would be? */
  function scorecard({ siteId, from, to }) {
    const period = periodReport({ siteId, from, to });
    const failures = [];
    if (!period.monitoring.compliant) {
      failures.push('vibration or airblast exceedance');
    }
    if (period.complaints.overdue > 0) {
      failures.push(`${period.complaints.overdue} complaints past their response window`);
    }
    if (period.inspections.flyrockCount > 0) {
      failures.push(`${period.inspections.flyrockCount} shots with flyrock`);
    }
    return {
      siteId,
      from,
      to,
      clean: failures.length === 0,
      failures,
      tonnes: period.tonnes,
      costPerTonne: period.cost.perTonne,
      powderFactorKgM3: period.powderFactorKgM3,
    };
  }

  return { blastReport, periodReport, scorecard };
}
