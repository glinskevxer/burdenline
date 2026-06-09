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
import * as monitoring from '../db/repositories/monitoring.js';
import * as postblast from '../db/repositories/postblast.js';
import * as community from '../db/repositories/community.js';
import * as costing from '../db/repositories/costing.js';
import { metresDrilled, explosiveUsed } from '../db/repositories/blast-facts.js';

export function createReportingService({ db, clock }) {
  /** Everything known about one shot. */
  function blastReport({ blastId, labourHours = 0, secondaryBreakingHours = 0 }) {
    const blast = blasts.findBlast(db, blastId);
    if (!blast) {
      throw new NotFoundError('blast', blastId);
    }
    const onDate = (blast.firedAt ?? clock.now()).slice(0, 10);
    const consumption = explosiveUsed(db, blast.id).products;
    const drilled = metresDrilled(db, blast.patternId);
    const tonnes = blast.volumeM3 ? roundTo(blast.volumeM3 * 2.7, 2) : null;
    const cost = costBlast({
      consumption,
      prices: costing.priceBook(db),
      rates: costing.rateBook(db, blast.siteId),
      metresDrilled: drilled,
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
      metresDrilled: drilled,
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
    const drilledMetres = roundTo(
      fired.reduce((sum, blast) => sum + metresDrilled(db, blast.patternId), 0),
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
      metresDrilled: drilledMetres,
      powderFactorKgM3: volumeM3 > 0 ? roundTo(chargeKg / volumeM3, 4) : null,
      drillingMetresPerTonne: tonnes > 0 ? roundTo(drilledMetres / tonnes, 5) : null,
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
