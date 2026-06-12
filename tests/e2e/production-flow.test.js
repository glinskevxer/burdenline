/**
 * The production side, end to end.
 *
 * A rig is matched to a pattern, drills it, the shot is fired and inspected, the
 * muckpile is surveyed and dug, and the month's productivity report is read off
 * the records that were made along the way. Nothing in this test fills in a form
 * for the sake of the report, which is the property worth guarding.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from '../http/helpers.js';

let harness;
let siteId;
let benchId;

const at = '2026-06-16T09:00:00.000Z';
const firedAt = '2026-06-15T13:30:00.000Z';
const period = 'from=2026-06-01T00:00:00.000Z&to=2026-06-30T23:59:00.000Z';

beforeEach(async () => {
  harness = await standUp({ at });
  siteId = harness.expectOk(
    await harness.post('/sites', 'admin', { code: 'MDW', name: 'Midway Quarry' }),
    201,
  ).site.id;
  benchId = harness.expectOk(
    await harness.post(`/sites/${siteId}/benches`, 'designer', {
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
    }),
    201,
  ).bench.id;
});

afterEach(async () => {
  await harness.close();
});

describe('from the rig to the productivity report', () => {
  it('carries the metres and the tonnes all the way', async () => {
    // A pattern and a fleet that can drill it.
    const pattern = harness.expectOk(
      await harness.post(`/benches/${benchId}/patterns`, 'designer', {
        reference: 'MDW-2026-080',
        origin: { easting: 1000, northing: 2000, level: 84 },
        faceBearingDeg: 0,
        layout: 'staggered',
        rowCount: 3,
        holesPerRow: 8,
        burdenM: 3,
        spacingM: 3.5,
        subdrillM: 1,
        diameterMm: 102,
      }),
      201,
    );
    harness.expectOk(
      await harness.post(`/sites/${siteId}/rigs`, 'admin', {
        fleetNumber: 'DR-01',
        make: 'Atlas',
        holeDiameterMinMm: 89,
        holeDiameterMaxMm: 115,
      }),
      201,
    );
    harness.expectOk(
      await harness.post(`/sites/${siteId}/rigs`, 'admin', {
        fleetNumber: 'DR-09',
        holeDiameterMinMm: 64,
        holeDiameterMaxMm: 89,
      }),
      201,
    );

    const options = harness.expectOk(
      await harness.get(`/patterns/${pattern.pattern.id}/rigs`, 'designer'),
    );
    expect(options.suitable.map((rig) => rig.fleetNumber)).toEqual(['DR-01']);
    expect(options.unsuitable[0].reasons[0]).toContain('64 to 89');
    const rigId = options.suitable[0].id;

    // It drills the pattern over two shifts.
    for (const [shiftDate, metres, holes] of [
      ['2026-06-12', 210, 13],
      ['2026-06-13', 174, 11],
    ]) {
      harness.expectOk(
        await harness.post(`/rigs/${rigId}/shifts`, 'shotfirer', {
          shift: 'day',
          shiftDate,
          metresDrilled: metres,
          holesDrilled: holes,
          hours: 8,
          downtimeMinutes: shiftDate === '2026-06-13' ? 45 : 0,
          downtimeReason: shiftDate === '2026-06-13' ? 'bit change' : undefined,
        }),
        201,
      );
    }
    const shifts = harness.expectOk(await harness.get(`/rigs/${rigId}/shifts`, 'manager'));
    expect(shifts.productivity.metres).toBe(384);
    expect(shifts.productivity.metresPerHour).toBeCloseTo(25.18, 1);

    // And the rig log lines up with the drill log that comes back.
    const csv = [
      'hole,depth',
      ...Array.from({ length: 24 }, (_unused, index) => `${index + 1},16`),
    ].join('\n');
    const drilled = harness.expectOk(
      await harness.post(`/patterns/${pattern.pattern.id}/drill-log`, 'designer', { csv }),
    );
    expect(drilled.written.updated).toBe(24);
    expect(drilled.reconciliation.ready).toBe(true);

    // The shot fires.
    const blast = harness.expectOk(
      await harness.post(`/sites/${siteId}/blasts`, 'designer', {
        reference: 'MDW-2026-080',
        patternId: pattern.pattern.id,
      }),
      201,
    ).blast;
    harness.expectOk(
      await harness.put(`/blasts/${blast.id}/totals`, 'designer', {
        volumeM3: 3780,
        holeCount: 24,
        totalChargeKg: 1040,
      }),
    );
    harness.db
      .prepare("UPDATE blast SET state = 'fired', fired_at = ? WHERE id = ?")
      .run(firedAt, blast.id);

    // Walked, surveyed and dug.
    harness.expectOk(
      await harness.post(`/blasts/${blast.id}/inspection`, 'shotfirer', {
        muckpileShape: 'moderate',
        throwM: 13,
        toeGrade: 'slight',
        backbreakM: 0.9,
        oversizeCount: 8,
      }),
      201,
    );
    harness.expectOk(
      await harness.post(`/blasts/${blast.id}/surveys`, 'designer', {
        method: 'laser_scan',
        volumeM3: 3960,
      }),
      201,
    );
    for (const [recordedOn, tonnes, hours] of [
      ['2026-06-16', 4200, 9],
      ['2026-06-17', 5100, 10],
    ]) {
      harness.expectOk(
        await harness.post(`/blasts/${blast.id}/dig-records`, 'viewer', {
          recordedOn,
          tonnes,
          hours,
        }),
        201,
      );
    }
    harness.expectOk(
      await harness.post(`/blasts/${blast.id}/secondary-breaking`, 'viewer', {
        method: 'hydraulic_hammer',
        boulderCount: 8,
        hours: 4,
      }),
      201,
    );

    // The yield reads off the survey rather than the design.
    const yielded = harness.expectOk(await harness.get(`/blasts/${blast.id}/yield`, 'manager'));
    expect(yielded.yield.volume.verdict).toBe('as_designed');
    expect(yielded.yield.digging.tonnesPerHour).toBeCloseTo(489.47, 1);
    expect(yielded.secondaryBreaking.hours).toBe(4);

    // And so does the month.
    const productivity = harness.expectOk(
      await harness.get(`/sites/${siteId}/productivity?${period}`, 'manager'),
    );
    expect(productivity.blastCount).toBe(1);
    expect(productivity.metresDrilled).toBe(384);
    expect(productivity.surveyedShots).toBe(1);
    expect(productivity.tonnesPerDiggingHour).toBeGreaterThan(0);
    expect(productivity.metresPerTonne).toBeGreaterThan(0);
    expect(productivity.hammerHoursPerThousandTonnes).toBeGreaterThan(0);

    const fleet = harness.expectOk(
      await harness.get(`/sites/${siteId}/productivity/rigs?${period}`, 'manager'),
    );
    expect(fleet.workingCount).toBe(1);
    expect(fleet.rigs[0].productivity.downtimeByReason['bit change']).toBe(45);
  });

  it('will not take a dig record before the muckpile has been walked', async () => {
    const blast = harness.expectOk(
      await harness.post(`/sites/${siteId}/blasts`, 'designer', { reference: 'MDW-2026-081' }),
      201,
    ).blast;
    harness.db
      .prepare("UPDATE blast SET state = 'fired', fired_at = ? WHERE id = ?")
      .run(firedAt, blast.id);
    const refused = await harness.post(`/blasts/${blast.id}/dig-records`, 'viewer', {
      tonnes: 1000,
      hours: 8,
    });
    expect(refused.statusCode).toBe(409);
    const productivity = harness.expectOk(
      await harness.get(`/sites/${siteId}/productivity?${period}`, 'manager'),
    );
    expect(productivity.diggingHours).toBe(0);
  });
});
