import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase, seedPerson } from '../helpers/database.js';
import { createProductivityService } from '../../src/services/productivity.service.js';
import { seedDemoSite } from '../../src/fixtures/demo-site.js';
import { createBlast, transition, recordDesignTotals } from '../../src/db/repositories/blasts.js';
import { recordInspection } from '../../src/db/repositories/postblast.js';
import {
  recordSurvey,
  recordDig,
  recordSecondaryBreaking,
} from '../../src/db/repositories/production.js';
import { createRig, recordShift } from '../../src/db/repositories/rigs.js';
import { fixedClock } from '../../src/lib/clock.js';
import { ValidationError } from '../../src/lib/errors.js';

let db;
let service;
let seeded;
const clock = fixedClock('2026-06-02T09:00:00Z');
const context = { clock };
const from = '2026-05-01T00:00:00.000Z';
const to = '2026-05-31T23:59:00.000Z';

function firedBlast(reference, firedAt, volumeM3 = 3780) {
  const blast = createBlast(
    db,
    { siteId: seeded.site.id, patternId: seeded.pattern.id, reference },
    context,
  );
  transition(db, blast.id, 'complete_design', {}, context);
  transition(db, blast.id, 'submit', {}, context);
  transition(db, blast.id, 'approve', { approverId: seeded.people[0].id }, context);
  recordDesignTotals(db, blast.id, { volumeM3, holeCount: 24, totalChargeKg: 900 }, context);
  transition(db, blast.id, 'load', { shotfirerId: seeded.people[2].id }, context);
  transition(db, blast.id, 'tie_in', {}, context);
  transition(db, blast.id, 'clear', { clearanceId: 'chk_1' }, context);
  transition(db, blast.id, 'fire', { shotfirerId: seeded.people[2].id, firedAt }, context);
  return blast.id;
}

function inspect(blastId) {
  return recordInspection(
    db,
    { blastId, inspectedAt: clock.now(), muckpileShape: 'moderate', throwM: 12, toeGrade: 'none' },
    { clock, holeCount: 24 },
  );
}

beforeEach(async () => {
  db = await openTestDatabase();
  seedPerson(db);
  seeded = seedDemoSite(db, { clock });
  service = createProductivityService({ db, clock });
});

afterEach(() => closeTestDatabase(db));

describe('period', () => {
  it('has nothing to report for a month with no shots', () => {
    const report = service.period({ siteId: seeded.site.id, from, to });
    expect(report.blastCount).toBe(0);
    expect(report.metresPerTonne).toBe(null);
  });

  it('reads the drilling off the holes that were drilled', () => {
    firedBlast('MDW-2026-040', '2026-05-10T13:00:00.000Z');
    const report = service.period({ siteId: seeded.site.id, from, to });
    expect(report.blastCount).toBe(1);
    expect(report.metresDrilled).toBeGreaterThan(300);
  });

  it('prefers the surveyed tonnage over the design volume', () => {
    const blastId = firedBlast('MDW-2026-041', '2026-05-11T13:00:00.000Z');
    const designOnly = service.period({ siteId: seeded.site.id, from, to }).tonnes;
    recordSurvey(db, { blastId, method: 'laser_scan', volumeM3: 4200 }, { clock });
    const surveyed = service.period({ siteId: seeded.site.id, from, to });
    expect(surveyed.tonnes).not.toBe(designOnly);
    expect(surveyed.surveyedShots).toBe(1);
  });

  it('works the two ratios out that a manager can act on', () => {
    const blastId = firedBlast('MDW-2026-042', '2026-05-12T13:00:00.000Z');
    recordSurvey(db, { blastId, method: 'laser_scan', volumeM3: 4000 }, { clock });
    const report = service.period({ siteId: seeded.site.id, from, to });
    expect(report.metresPerTonne).toBeGreaterThan(0);
    expect(report.explosivePerTonne).toBeGreaterThanOrEqual(0);
  });

  it('reads the digging off the dig records', () => {
    const blastId = firedBlast('MDW-2026-043', '2026-05-13T13:00:00.000Z');
    inspect(blastId);
    recordDig(db, { blastId, tonnes: 5000, hours: 10 }, { clock });
    const report = service.period({ siteId: seeded.site.id, from, to });
    expect(report.diggingHours).toBe(10);
    expect(report.tonnesPerDiggingHour).toBeGreaterThan(0);
  });

  it('counts the hammer against the tonnes it took to break', () => {
    const blastId = firedBlast('MDW-2026-044', '2026-05-14T13:00:00.000Z');
    recordSurvey(db, { blastId, method: 'laser_scan', volumeM3: 4000 }, { clock });
    recordSecondaryBreaking(db, { blastId, method: 'hydraulic_hammer', hours: 8 }, { clock });
    const report = service.period({ siteId: seeded.site.id, from, to });
    expect(report.secondaryBreakingHours).toBe(8);
    expect(report.hammerHoursPerThousandTonnes).toBeGreaterThan(0);
  });

  it('leaves a shot outside the period out', () => {
    firedBlast('MDW-2026-045', '2026-04-10T13:00:00.000Z');
    expect(service.period({ siteId: seeded.site.id, from, to }).blastCount).toBe(0);
  });

  it('refuses a report with no period', () => {
    expect(() => service.period({ siteId: seeded.site.id })).toThrow(ValidationError);
  });
});

describe('rigs', () => {
  function rigWithShift(fleetNumber, metres, hours, downtime = 0) {
    const rig = createRig(
      db,
      { siteId: seeded.site.id, fleetNumber, holeDiameterMinMm: 89, holeDiameterMaxMm: 115 },
      context,
    );
    recordShift(
      db,
      {
        rigId: rig.id,
        shift: 'day',
        shiftDate: '2026-05-12',
        metresDrilled: metres,
        holesDrilled: 12,
        hours,
        downtimeMinutes: downtime,
      },
      context,
    );
    return rig;
  }

  it('puts the fastest rig first', () => {
    rigWithShift('DR-01', 180, 8);
    rigWithShift('DR-02', 260, 8);
    const report = service.rigs({ siteId: seeded.site.id, from: '2026-05-01', to: '2026-05-31' });
    expect(report.rigs[0].rig.fleetNumber).toBe('DR-02');
    expect(report.bestMetresPerHour).toBeCloseTo(32.5, 1);
  });

  it('counts only the rigs that worked', () => {
    rigWithShift('DR-01', 180, 8);
    createRig(
      db,
      {
        siteId: seeded.site.id,
        fleetNumber: 'DR-09',
        holeDiameterMinMm: 76,
        holeDiameterMaxMm: 89,
      },
      context,
    );
    const report = service.rigs({ siteId: seeded.site.id, from: '2026-05-01', to: '2026-05-31' });
    expect(report.rigs).toHaveLength(2);
    expect(report.workingCount).toBe(1);
  });

  it('adds the downtime up', () => {
    rigWithShift('DR-01', 180, 8, 45);
    const report = service.rigs({ siteId: seeded.site.id, from: '2026-05-01', to: '2026-05-31' });
    expect(report.downtimeMinutes).toBe(45);
  });
});

describe('trend', () => {
  it('puts two periods against each other', () => {
    const first = firedBlast('MDW-2026-050', '2026-04-10T13:00:00.000Z');
    recordSurvey(db, { blastId: first, method: 'laser_scan', volumeM3: 4000 }, { clock });
    const second = firedBlast('MDW-2026-051', '2026-05-10T13:00:00.000Z');
    recordSurvey(db, { blastId: second, method: 'laser_scan', volumeM3: 5000 }, { clock });
    const result = service.trend({
      siteId: seeded.site.id,
      current: { from, to },
      previous: { from: '2026-04-01T00:00:00.000Z', to: '2026-04-30T23:59:00.000Z' },
    });
    expect(result.changes.tonnes.percent).toBeGreaterThan(0);
    expect(result.changes.metresPerTonne.percent).toBeLessThan(0);
    expect(result.generatedAt).toBe(clock.now());
  });

  it('says nothing rather than dividing by a period with no tonnes in it', () => {
    firedBlast('MDW-2026-052', '2026-05-10T13:00:00.000Z');
    const result = service.trend({
      siteId: seeded.site.id,
      current: { from, to },
      previous: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' },
    });
    expect(result.changes.tonnes.percent).toBe(null);
  });
});
