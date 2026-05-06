/**
 * The exceedance watch.
 *
 * Runs after every import and on a timer. It looks for records over a limit that
 * nobody has acted on yet, and for the pattern that matters more than any single
 * reading: the same receptor going over twice inside the rolling window, which
 * is what turns a one off into a compliance history.
 *
 * It does not send anything. Telling a regulator is a decision with a person's
 * name on it, and a job that emails one automatically is a job that will
 * eventually email one about a monitor that was knocked over by a loader.
 */

import { defineJob } from './framework.js';
import { listWhere } from '../db/repository.js';
import { listRecords, listReceptors } from '../db/repositories/monitoring.js';
import { evaluateAll, exceedances, repeatExceedances } from '../domain/monitoring/compliance.js';
import { listComplaints } from '../db/repositories/community.js';

export function exceedanceWatchJob({ lookbackDays = 30, repeatWindowDays = 90 } = {}) {
  return defineJob({
    name: 'exceedance-watch',
    summary: 'find readings over a limit and receptors going over more than once',
    async run({ db, clock }) {
      const now = clock.now();
      const from = new Date(Date.parse(now) - lookbackDays * 86400000).toISOString();
      const sites = listWhere(db, 'site', {}, { orderBy: 'code' });
      const findings = [];
      const repeats = [];
      let examined = 0;

      for (const site of sites) {
        const records = listRecords(db, site.id, { from, to: now, limit: 2000 });
        if (records.length === 0) {
          continue;
        }
        examined += records.length;
        const receptors = new Map(
          listReceptors(db, site.id).map((receptor) => [receptor.id, receptor]),
        );
        const { results } = evaluateAll(records, receptors);
        const over = exceedances(results);
        const complaints = listComplaints(db, site.id, { from, to: now, limit: 500 });

        for (const item of over) {
          findings.push({
            siteId: site.id,
            siteCode: site.code,
            receptorId: item.receptorId,
            receptorName: receptors.get(item.receptorId)?.name ?? null,
            triggeredAt: item.triggeredAt,
            channels: item.channels,
            measured: item.ground.peakMmPerSecond,
            limit: item.ground.limitMmPerSecond,
            // A reading over the limit with a complaint on the same day is a
            // different conversation from one nobody noticed.
            complaintSameDay: complaints.some(
              (complaint) => complaint.receivedAt.slice(0, 10) === item.triggeredAt.slice(0, 10),
            ),
          });
        }
        for (const repeat of repeatExceedances(results, { withinDays: repeatWindowDays })) {
          repeats.push({
            siteId: site.id,
            siteCode: site.code,
            receptorName: receptors.get(repeat.receptorId)?.name ?? null,
            ...repeat,
          });
        }
      }

      return {
        examined,
        found: findings.length,
        acted: 0,
        details: findings,
        exceedances: findings,
        repeats,
        note:
          findings.length === 0
            ? `nothing over a limit in the last ${lookbackDays} days`
            : `${findings.length} readings over a limit, ${repeats.length} receptors over more than once`,
      };
    },
  });
}
