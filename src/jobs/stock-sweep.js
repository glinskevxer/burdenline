/**
 * The stock sweep.
 *
 * Three things go wrong in a magazine between one stocktake and the next: the
 * balance drifts over the licence, a batch reads negative because a movement was
 * entered the wrong way round, and stock quietly goes out of date on the shelf.
 * None of them announce themselves, and all three are cheap to find every
 * morning.
 */

import { defineJob } from './framework.js';
import { listWhere } from '../db/repository.js';
import { stockFor, listBatches, listProducts, getMagazine } from '../db/repositories/explosives.js';
import { batchStatus } from '../domain/magazine/batches.js';

export function stockSweepJob({ warnWithinDays = 30 } = {}) {
  return defineJob({
    name: 'stock-sweep',
    summary: 'check every magazine against its licence and its stock against its dates',
    async run({ db, clock }) {
      const asOf = clock.now();
      const magazines = listWhere(db, 'magazine', { status: 'active' }, { orderBy: 'name' });
      const findings = [];
      for (const magazine of magazines) {
        const state = stockFor(db, magazine.id);
        for (const violation of state.violations) {
          findings.push({
            magazineId: magazine.id,
            magazineName: magazine.name,
            rule: violation.rule,
            message: violation.message,
          });
        }
        if (state.utilisation > 0.9 && state.valid) {
          findings.push({
            magazineId: magazine.id,
            magazineName: magazine.name,
            rule: 'magazine.near_licence',
            message: `${magazine.name} is at ${Math.round(state.utilisation * 100)} percent of its licence`,
          });
        }
      }

      const dated = [];
      for (const product of listProducts(db)) {
        for (const batch of listBatches(db, product.id)) {
          const status = batchStatus({ ...batch, expiresOn: batch.expiresOn }, asOf, {
            warnWithinDays,
            quarantineOnExpiry: true,
            maximumSleepOvershootHours: 0,
          });
          if (status.status === 'usable') {
            continue;
          }
          dated.push({
            batchId: batch.id,
            batchCode: batch.batchCode,
            productCode: product.code,
            status: status.status,
            daysRemaining: status.daysRemaining,
          });
        }
      }

      return {
        examined: magazines.length,
        found: findings.length + dated.length,
        acted: 0,
        details: findings,
        magazines: findings,
        batches: dated,
        note:
          findings.length + dated.length === 0
            ? 'every magazine is inside its licence and nothing is out of date'
            : `${findings.length} magazine findings, ${dated.length} batches expiring or expired`,
      };
    },
  });
}

/**
 * Holes that have been loaded too long. A pumped emulsion has a sleep time and a
 * hole left past it has to be treated as suspect, which is a decision somebody
 * has to make before the crew turns up expecting to fire it.
 */
export function sleepingHolesJob() {
  return defineJob({
    name: 'sleeping-holes',
    summary: 'find loaded shots that have been sitting past the product sleep time',
    async run({ db, clock }) {
      const asOf = clock.now();
      const loaded = db
        .prepare(
          `SELECT b.id, b.reference, b.state, b.updated_at AS loadedAt, b.site_id AS siteId
           FROM blast b WHERE b.state IN ('loaded', 'tied_in', 'cleared')`,
        )
        .all();
      const overdue = [];
      for (const blast of loaded) {
        const products = db
          .prepare(
            `SELECT DISTINCT p.code, p.sleep_time_hours AS sleepTimeHours
             FROM charge_deck d JOIN product p ON p.id = d.product_id
             WHERE d.blast_id = ? AND p.sleep_time_hours IS NOT NULL`,
          )
          .all(blast.id);
        for (const product of products) {
          const hours = (Date.parse(asOf) - Date.parse(blast.loadedAt)) / 3600000;
          if (hours > product.sleepTimeHours) {
            overdue.push({
              blastId: blast.id,
              reference: blast.reference,
              productCode: product.code,
              hoursLoaded: Math.round(hours * 10) / 10,
              sleepTimeHours: product.sleepTimeHours,
            });
          }
        }
      }
      return {
        examined: loaded.length,
        found: overdue.length,
        acted: 0,
        details: overdue,
        overdue,
        note:
          overdue.length === 0
            ? 'nothing loaded is past its sleep time'
            : `${overdue.length} loaded shots are past the sleep time of a product in them`,
      };
    },
  });
}

export function magazineNames(db, ids) {
  return ids.map((id) => getMagazine(db, id).name);
}
