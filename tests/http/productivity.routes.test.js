import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';
import { seedDemoSite } from '../../src/fixtures/demo-site.js';
import { createBlast, transition, recordDesignTotals } from '../../src/db/repositories/blasts.js';
import { recordSurvey } from '../../src/db/repositories/production.js';
import { createRig, recordShift } from '../../src/db/repositories/rigs.js';

let harness;
let siteId;
let seeded;

const at = '2026-06-08T09:00:00.000Z';
const period = 'from=2026-05-01T00:00:00.000Z&to=2026-05-31T23:59:00.000Z';

function firedBlast(reference, firedAt) {
  const context = { clock: harness.clock };
  const blast = createBlast(
    harness.db,
    { siteId, patternId: seeded.pattern.id, reference },
    context,
  );
  transition(harness.db, blast.id, 'complete_design', {}, context);
  transition(harness.db, blast.id, 'submit', {}, context);
  transition(harness.db, blast.id, 'approve', { approverId: seeded.people[0].id }, context);
  recordDesignTotals(harness.db, blast.id, { volumeM3: 3780, holeCount: 24 }, context);
  transition(harness.db, blast.id, 'load', { shotfirerId: seeded.people[2].id }, context);
  transition(harness.db, blast.id, 'tie_in', {}, context);
  transition(harness.db, blast.id, 'clear', { clearanceId: 'chk_1' }, context);
  transition(harness.db, blast.id, 'fire', { shotfirerId: seeded.people[2].id, firedAt }, context);
  return blast.id;
}

beforeEach(async () => {
  harness = await standUp({ at });
  seeded = seedDemoSite(harness.db, { clock: harness.clock });
  siteId = seeded.site.id;
});

afterEach(async () => {
  await harness.close();
});

describe('GET /sites/:siteId/productivity', () => {
  it('reports a quiet month as nothing done', async () => {
    const report = harness.expectOk(
      await harness.get(`/sites/${siteId}/productivity?${period}`, 'manager'),
    );
    expect(report.blastCount).toBe(0);
    expect(report.metresPerTonne).toBe(null);
  });

  it('reports the drilling and the ratios once a shot has fired', async () => {
    const blastId = firedBlast('MDW-2026-060', '2026-05-12T13:00:00.000Z');
    recordSurvey(
      harness.db,
      { blastId, method: 'laser_scan', volumeM3: 4000 },
      { clock: harness.clock },
    );
    const report = harness.expectOk(
      await harness.get(`/sites/${siteId}/productivity?${period}`, 'manager'),
    );
    expect(report.blastCount).toBe(1);
    expect(report.metresDrilled).toBeGreaterThan(300);
    expect(report.metresPerTonne).toBeGreaterThan(0);
    expect(report.surveyedShots).toBe(1);
  });

  it('refuses a request with no period', async () => {
    expect((await harness.get(`/sites/${siteId}/productivity`, 'manager')).statusCode).toBe(422);
  });

  it('is readable by anybody who can read the site', async () => {
    expect(
      (await harness.get(`/sites/${siteId}/productivity?${period}`, 'viewer')).statusCode,
    ).toBe(200);
  });
});

describe('GET /sites/:siteId/productivity/rigs', () => {
  it('lists the fleet fastest first', async () => {
    const context = { clock: harness.clock };
    for (const [fleetNumber, metres] of [
      ['DR-01', 180],
      ['DR-02', 260],
    ]) {
      const rig = createRig(
        harness.db,
        { siteId, fleetNumber, holeDiameterMinMm: 89, holeDiameterMaxMm: 115 },
        context,
      );
      recordShift(
        harness.db,
        { rigId: rig.id, shift: 'day', shiftDate: '2026-05-12', metresDrilled: metres, hours: 8 },
        context,
      );
    }
    const report = harness.expectOk(
      await harness.get(`/sites/${siteId}/productivity/rigs?${period}`, 'manager'),
    );
    expect(report.rigs[0].rig.fleetNumber).toBe('DR-02');
    expect(report.workingCount).toBe(2);
    expect(report.totalMetres).toBe(440);
  });

  it('reports an empty fleet without falling over', async () => {
    const report = harness.expectOk(
      await harness.get(`/sites/${siteId}/productivity/rigs?${period}`, 'manager'),
    );
    expect(report.rigs).toEqual([]);
    expect(report.bestMetresPerHour).toBe(null);
  });
});

describe('GET /sites/:siteId/productivity/trend', () => {
  it('puts two months against each other', async () => {
    const first = firedBlast('MDW-2026-061', '2026-04-12T13:00:00.000Z');
    recordSurvey(
      harness.db,
      { blastId: first, method: 'laser_scan', volumeM3: 4000 },
      { clock: harness.clock },
    );
    const second = firedBlast('MDW-2026-062', '2026-05-12T13:00:00.000Z');
    recordSurvey(
      harness.db,
      { blastId: second, method: 'laser_scan', volumeM3: 5200 },
      { clock: harness.clock },
    );
    const url = `/sites/${siteId}/productivity/trend?${period}&previousFrom=2026-04-01T00:00:00.000Z&previousTo=2026-04-30T23:59:00.000Z`;
    const report = harness.expectOk(await harness.get(url, 'manager'));
    expect(report.changes.tonnes.percent).toBeGreaterThan(0);
    expect(report.current.blastCount).toBe(1);
    expect(report.previous.blastCount).toBe(1);
  });

  it('refuses a trend with only one period on it', async () => {
    expect(
      (await harness.get(`/sites/${siteId}/productivity/trend?${period}`, 'manager')).statusCode,
    ).toBe(422);
  });
});
