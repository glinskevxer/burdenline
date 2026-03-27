/**
 * The ordering sweep and the notice sweep.
 *
 * Both answer a question nobody remembers to ask on a Friday afternoon: is
 * anything about to run out, and has everybody who should have been told about
 * Monday's shot actually been told. Neither does anything about it; they report,
 * because ordering explosive and ringing a neighbour are both things a person
 * has to do.
 */

import { defineJob } from './framework.js';
import { listWhere } from '../db/repository.js';
import { reviewSupply } from '../db/repositories/orders.js';
import { listNotifications } from '../db/repositories/community.js';
import { checkNotice } from '../domain/community/notifications.js';
import { rulesFor } from '../db/repositories/site-rules.js';

export function supplyReviewJob() {
  return defineJob({
    name: 'supply-review',
    summary: 'check every store against what it has been using',
    async run({ db }) {
      const sites = listWhere(db, 'site', {}, { orderBy: 'code' });
      const findings = [];
      let examined = 0;
      for (const site of sites) {
        const magazines = listWhere(db, 'magazine', { siteId: site.id, status: 'active' });
        if (magazines.length === 0) {
          continue;
        }
        examined += 1;
        const review = reviewSupply(db, site.id);
        for (const item of review.toOrder) {
          findings.push({
            siteId: site.id,
            siteCode: site.code,
            productCode: item.productCode,
            action: item.action,
            held: item.held,
            daysOfCover: item.daysOfCover,
            suggestedQuantity: item.suggestedQuantity,
          });
        }
      }
      const urgent = findings.filter((finding) => finding.action === 'urgent');
      return {
        examined,
        found: findings.length,
        acted: 0,
        details: findings,
        urgent,
        note:
          findings.length === 0
            ? 'every store has enough for the way it has been going'
            : `${findings.length} products to order, ${urgent.length} urgent`,
      };
    },
  });
}

/**
 * Shots planned for the next few days whose neighbours have not been told, or
 * were told at the wrong time. Run in the morning, it gives a day to fix it.
 */
export function noticeSweepJob({ withinHours = 72 } = {}) {
  return defineJob({
    name: 'notice-sweep',
    summary: 'find shots due soon whose neighbours have not been told properly',
    async run({ db, clock }) {
      const now = clock.now();
      const horizon = new Date(Date.parse(now) + withinHours * 3600 * 1000).toISOString();
      const upcoming = db
        .prepare(
          `SELECT id, reference, site_id AS siteId, planned_for AS plannedFor
           FROM blast
           WHERE planned_for IS NOT NULL
             AND planned_for >= @now AND planned_for <= @horizon
             AND state NOT IN ('fired', 'closed', 'abandoned', 'misfired', 'made_safe', 'inspected')`,
        )
        .all({ now, horizon });

      const findings = [];
      for (const blast of upcoming) {
        const notifications = listNotifications(db, blast.id);
        if (notifications.length === 0) {
          findings.push({
            blastId: blast.id,
            reference: blast.reference,
            plannedFor: blast.plannedFor,
            rule: 'notice.none_planned',
            message: `${blast.reference} is planned for ${blast.plannedFor} and nobody has been listed to tell`,
          });
          continue;
        }
        const rules = rulesFor(db, blast.siteId, 'notice').values;
        const result = checkNotice({
          notifications: notifications.map((notification) => ({
            blastId: notification.blastId,
            receptorId: notification.receptorId,
            channel: notification.channel,
            addressedTo: notification.addressedTo,
            plannedFor: notification.plannedFor,
            sentAt: notification.sentAt,
            state: notification.state,
            failureReason: notification.failureReason,
          })),
          firingAt: blast.plannedFor,
          rules,
        });
        for (const violation of result.violations) {
          findings.push({
            blastId: blast.id,
            reference: blast.reference,
            plannedFor: blast.plannedFor,
            ...violation,
          });
        }
      }
      return {
        examined: upcoming.length,
        found: findings.length,
        acted: 0,
        details: findings,
        note:
          findings.length === 0
            ? `nothing due inside ${withinHours} hours is short of notice`
            : `${findings.length} notice problems on shots due inside ${withinHours} hours`,
      };
    },
  });
}
