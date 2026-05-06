import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase, seedPerson } from '../helpers/database.js';
import { runJob } from '../../src/jobs/framework.js';
import { exceedanceWatchJob } from '../../src/jobs/exceedance-watch.js';
import { createSite } from '../../src/db/repositories/sites.js';
import { createReceptor, importRecords } from '../../src/db/repositories/monitoring.js';
import { recordComplaint } from '../../src/db/repositories/community.js';
import { parseRecord } from '../../src/domain/monitoring/records.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';

let db;
let siteId;
let receptorId;
const clock = fixedClock('2026-05-12T06:00:00Z');
const context = () => ({ db, clock, logger: silentLogger() });

function record(peak, triggeredAt, overrides = {}) {
  return parseRecord({
    monitorSerial: 'BE-11482',
    receptorId,
    triggeredAt,
    distanceM: 400,
    longitudinal: { peakMmPerSecond: 1, frequencyHz: 20 },
    transverse: { peakMmPerSecond: peak, frequencyHz: 20 },
    vertical: { peakMmPerSecond: 1, frequencyHz: 20 },
    ...overrides,
  });
}

beforeEach(async () => {
  db = await openTestDatabase();
  seedPerson(db);
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, { clock }).id;
  receptorId = createReceptor(
    db,
    { siteId, name: 'Keeper cottage', structureClass: 'dwelling', easting: 1400, northing: 2000 },
    { clock },
  ).id;
});

afterEach(() => closeTestDatabase(db));

describe('the exceedance watch', () => {
  it('says nothing about a quiet month', async () => {
    importRecords(db, siteId, [record(3.1, '2026-05-10T13:00:00.000Z')], { clock });
    const result = await runJob(exceedanceWatchJob(), context());
    expect(result.found).toBe(0);
    expect(result.note).toContain('nothing over a limit');
  });

  it('finds a reading over the limit', async () => {
    importRecords(db, siteId, [record(26, '2026-05-10T13:00:00.000Z')], { clock });
    const result = await runJob(exceedanceWatchJob(), context());
    expect(result.found).toBe(1);
    expect(result.data.exceedances[0].receptorName).toBe('Keeper cottage');
    expect(result.data.exceedances[0].measured).toBe(26);
  });

  it('says whether a complaint came in the same day', async () => {
    importRecords(db, siteId, [record(26, '2026-05-10T13:00:00.000Z')], { clock });
    recordComplaint(
      db,
      {
        siteId,
        receivedAt: '2026-05-10T15:00:00.000Z',
        channel: 'telephone',
        about: 'vibration',
        description: 'the whole house shook just after two',
      },
      { clock, actorId: 'per_1' },
    );
    const result = await runJob(exceedanceWatchJob(), context());
    expect(result.data.exceedances[0].complaintSameDay).toBe(true);
  });

  it('spots a receptor going over twice inside the window', async () => {
    importRecords(
      db,
      siteId,
      [record(32, '2026-04-20T13:00:00.000Z'), record(30, '2026-05-10T13:00:00.000Z')],
      { clock },
    );
    const result = await runJob(exceedanceWatchJob(), context());
    expect(result.data.repeats).toHaveLength(1);
    expect(result.data.repeats[0].receptorName).toBe('Keeper cottage');
  });

  it('looks back only as far as it was told to', async () => {
    importRecords(db, siteId, [record(26, '2026-01-10T13:00:00.000Z')], { clock });
    expect((await runJob(exceedanceWatchJob(), context())).found).toBe(0);
    expect((await runJob(exceedanceWatchJob({ lookbackDays: 200 }), context())).found).toBe(1);
  });

  it('does not send anything anywhere', async () => {
    importRecords(db, siteId, [record(26, '2026-05-10T13:00:00.000Z')], { clock });
    const result = await runJob(exceedanceWatchJob(), context());
    expect(result.acted).toBe(0);
  });

  it('leaves a site with no records out of the count', async () => {
    createSite(db, { code: 'RCK', name: 'Rockfield' }, { clock });
    const result = await runJob(exceedanceWatchJob(), context());
    expect(result.examined).toBe(0);
  });
});
