/**
 * A complaint from the telephone call to the regulator return.
 *
 * The path a complaint actually takes: somebody rings, it gets matched to a
 * shot, the monitor records are put beside it, a letter goes back, and the whole
 * thing turns up in the month's return whether or not anybody wanted it to.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from '../http/helpers.js';
import { importRecords } from '../../src/db/repositories/monitoring.js';
import { parseRecord } from '../../src/domain/monitoring/records.js';

let harness;
let siteId;
let receptorId;
let blastId;

const at = '2026-05-20T09:00:00.000Z';
const firedAt = '2026-05-19T14:02:00.000Z';

function record(peak, triggeredAt) {
  return parseRecord({
    monitorSerial: 'BE-11482',
    receptorId,
    triggeredAt,
    distanceM: 400,
    longitudinal: { peakMmPerSecond: 1.4, frequencyHz: 18 },
    transverse: { peakMmPerSecond: peak, frequencyHz: 18 },
    vertical: { peakMmPerSecond: 1.1, frequencyHz: 22 },
    airblastDb: 113.2,
  });
}

beforeEach(async () => {
  harness = await standUp({ at });
  siteId = harness.expectOk(
    await harness.post('/sites', 'admin', {
      code: 'MDW',
      name: 'Midway Quarry',
      licenceNumber: 'EL-4471',
      timeZone: 'Europe/Dublin',
    }),
    201,
  ).site.id;
  receptorId = harness.expectOk(
    await harness.post(`/sites/${siteId}/receptors`, 'admin', {
      name: 'Keeper cottage',
      structureClass: 'older_dwelling',
      easting: 1400,
      northing: 2000,
      monitored: true,
      notifiable: true,
    }),
    201,
  ).receptor.id;
  blastId = harness.expectOk(
    await harness.post(`/sites/${siteId}/blasts`, 'designer', { reference: 'MDW-2026-021' }),
    201,
  ).blast.id;
  harness.db
    .prepare(
      "UPDATE blast SET state = 'fired', fired_at = ?, total_charge_kg = 980, instantaneous_charge_kg = 86, hole_count = 24 WHERE id = ?",
    )
    .run(firedAt, blastId);
});

afterEach(async () => {
  await harness.close();
});

describe('a complaint that lines up with a shot', () => {
  it('is taken, matched, answered and reported', async () => {
    importRecords(harness.db, siteId, [record(4.8, '2026-05-19T14:02:06.000Z')], {
      clock: harness.clock,
    });

    // The call comes in the next morning.
    const complaint = harness.expectOk(
      await harness.post(`/sites/${siteId}/complaints`, 'viewer', {
        channel: 'telephone',
        about: 'vibration',
        complainant: 'Mrs Hurley',
        contact: '086 000 0000',
        receptorId,
        occurredAt: firedAt,
        description: 'the pictures came off the wall just after two yesterday afternoon',
      }),
      201,
    ).complaint;
    expect(complaint.state).toBe('open');

    // It matches the shot, and the readings are there to put beside it.
    const read = harness.expectOk(await harness.get(`/complaints/${complaint.id}`, 'manager'));
    expect(read.match.matched).toBe(true);
    expect(read.match.best.blast.reference).toBe('MDW-2026-021');
    expect(read.supporting).toHaveLength(1);
    expect(read.clock.overdue).toBe(false);

    // Somebody ties it to the shot and looks into it.
    harness.expectOk(
      await harness.post(`/complaints/${complaint.id}/blast`, 'manager', { blastId }),
    );
    harness.expectOk(await harness.post(`/complaints/${complaint.id}/investigate`, 'manager'));

    // The letter is drafted from the record rather than from memory.
    const draft = harness.expectOk(
      await harness.get(`/complaints/${complaint.id}/response`, 'manager'),
    );
    expect(draft.letter).toContain('MDW-2026-021');
    expect(draft.letter).toContain('4.8 millimetres per second');
    expect(draft.response.facts.overLimit).toBe(false);

    // And the reply closes it.
    const responded = harness.expectOk(
      await harness.post(`/complaints/${complaint.id}/respond`, 'manager', {
        outcome: 'answered by letter with the reading from the cottage monitor',
      }),
    ).complaint;
    expect(responded.state).toBe('responded');
    harness.expectOk(await harness.post(`/complaints/${complaint.id}/close`, 'manager'));

    // The month's return carries it whether anybody wanted it to or not.
    const pack = harness.expectOk(
      await harness.get(
        `/sites/${siteId}/regulator-pack?from=2026-05-01T00:00:00.000Z&to=2026-05-31T23:59:00.000Z`,
        'manager',
      ),
    ).pack;
    expect(pack.complaints.count).toBe(1);
    expect(pack.complaints.rows[0].outcome).toContain('answered by letter');
    expect(pack.vibration.highest).toBe(4.8);
    expect(pack.summary.compliant).toBe(true);
  });

  it('carries an exceedance into the letter and the return together', async () => {
    importRecords(harness.db, siteId, [record(26, '2026-05-19T14:02:06.000Z')], {
      clock: harness.clock,
    });
    const complaint = harness.expectOk(
      await harness.post(`/sites/${siteId}/complaints`, 'viewer', {
        channel: 'telephone',
        about: 'vibration',
        receptorId,
        occurredAt: firedAt,
        description: 'the whole house shook and a cup came off the shelf',
      }),
      201,
    ).complaint;
    const draft = harness.expectOk(
      await harness.get(`/complaints/${complaint.id}/response`, 'manager'),
    );
    expect(draft.response.facts.overLimit).toBe(true);
    expect(draft.letter).toContain('reported it to the regulator');

    const pack = harness.expectOk(
      await harness.get(
        `/sites/${siteId}/regulator-pack?from=2026-05-01T00:00:00.000Z&to=2026-05-31T23:59:00.000Z`,
        'manager',
      ),
    ).pack;
    expect(pack.summary.compliant).toBe(false);
    expect(pack.exceedances.count).toBe(1);
    expect(pack.exceedances.rows[0].measured).toBe(26);
  });

  it('says plainly when a complaint lines up with no shot at all', async () => {
    const complaint = harness.expectOk(
      await harness.post(`/sites/${siteId}/complaints`, 'viewer', {
        channel: 'telephone',
        about: 'noise',
        receptorId,
        occurredAt: '2026-05-17T21:30:00.000Z',
        description: 'the crusher was running well past nine on Sunday evening',
      }),
      201,
    ).complaint;
    const read = harness.expectOk(await harness.get(`/complaints/${complaint.id}`, 'manager'));
    expect(read.match.matched).toBe(false);
    const draft = harness.expectOk(
      await harness.get(`/complaints/${complaint.id}/response`, 'manager'),
    );
    expect(draft.letter).toContain('did not fire a blast');
  });

  it('shows a complaint left unanswered as overdue on the site register', async () => {
    harness.expectOk(
      await harness.post(`/sites/${siteId}/complaints`, 'viewer', {
        channel: 'letter',
        about: 'dust',
        receivedAt: '2026-05-01T09:00:00.000Z',
        description: 'dust over the washing every dry day this month',
      }),
      201,
    );
    const register = harness.expectOk(await harness.get(`/sites/${siteId}/complaints`, 'manager'));
    expect(register.summary.openCount).toBe(1);
    expect(register.summary.overdue).toBe(1);
  });
});
