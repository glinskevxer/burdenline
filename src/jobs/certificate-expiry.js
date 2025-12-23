/**
 * The certificate sweep.
 *
 * Runs every morning and answers one question: is anybody about to stop being
 * allowed to do the thing they are rostered to do this week. A certificate that
 * has already lapsed is reported separately from one about to lapse, because the
 * first is somebody who cannot work today and the second is a diary entry.
 */

import { defineJob } from './framework.js';
import { rowsToObjects } from '../db/repository.js';
import { daysToExpiry } from '../domain/people/competency.js';

export function certificateExpiryJob({ warnWithinDays = 60 } = {}) {
  return defineJob({
    name: 'certificate-expiry',
    summary: 'find certificates that have lapsed or are about to',
    async run({ db, clock }) {
      const onDate = clock.date();
      const rows = rowsToObjects(
        db
          .prepare(
            `SELECT c.*, p.name AS person_name, p.active
             FROM certificate c JOIN person p ON p.id = c.person_id
             WHERE p.active = 1
             ORDER BY c.expires_on`,
          )
          .all(),
      );
      const lapsed = [];
      const expiring = [];
      for (const row of rows) {
        const remaining = daysToExpiry({ expiresOn: row.expiresOn }, onDate);
        const entry = {
          certificateId: row.id,
          personId: row.personId,
          personName: row.personName,
          kind: row.kind,
          expiresOn: row.expiresOn,
          daysRemaining: remaining,
          suspended: row.suspended === 1,
        };
        if (remaining < 0 || row.suspended === 1) {
          lapsed.push(entry);
        } else if (remaining <= warnWithinDays) {
          expiring.push(entry);
        }
      }
      return {
        examined: rows.length,
        found: lapsed.length + expiring.length,
        acted: 0,
        details: [...lapsed, ...expiring],
        note:
          lapsed.length === 0 && expiring.length === 0
            ? 'every certificate on file is current'
            : `${lapsed.length} lapsed, ${expiring.length} inside ${warnWithinDays} days`,
        lapsed,
        expiring,
      };
    },
  });
}
