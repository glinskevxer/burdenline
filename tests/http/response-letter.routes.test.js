import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';
import { importRecords } from '../../src/db/repositories/monitoring.js';
import { parseRecord } from '../../src/domain/monitoring/records.js';

let harness;
let siteId;
let receptorId;

const at = '2026-05-14T09:00:00.000Z';

async function complaint(overrides = {}) {
  return harness.post(`/sites/${siteId}/complaints`, 'manager', {
    channel: 'telephone',
    about: 'vibration',
    complainant: 'Mrs Hurley',
    description: 'the pictures came off the wall just after two yesterday afternoon',
    occurredAt: '2026-05-13T14:02:00.000Z',
    receptorId,
    ...overrides,
  });
}

function record(peak, triggeredAt) {
  return parseRecord({
    monitorSerial: 'BE-11482',
    receptorId,
    triggeredAt,
    distanceM: 400,
    longitudinal: { peakMmPerSecond: 1, frequencyHz: 20 },
    transverse: { peakMmPerSecond: peak, frequencyHz: 20 },
    vertical: { peakMmPerSecond: 1, frequencyHz: 20 },
  });
}

beforeEach(async () => {
  harness = await standUp({ at });
  siteId = harness.expectOk(
    await harness.post('/sites', 'admin', { code: 'MDW', name: 'Midway Quarry' }),
    201,
  ).site.id;
  receptorId = harness.expectOk(
    await harness.post(`/sites/${siteId}/receptors`, 'admin', {
      name: 'Keeper cottage',
      structureClass: 'dwelling',
      easting: 1400,
      northing: 2000,
      monitored: true,
    }),
    201,
  ).receptor.id;
});

afterEach(async () => {
  await harness.close();
});

describe('GET /complaints/:complaintId/response', () => {
  it('drafts a letter from the record', async () => {
    const id = harness.expectOk(await complaint(), 201).complaint.id;
    const response = harness.expectOk(await harness.get(`/complaints/${id}/response`, 'manager'));
    expect(response.letter).toContain('To: Mrs Hurley');
    expect(response.letter).toContain('Thank you for contacting us');
    expect(response.response.facts.complaintId).toBe(id);
  });

  it('quotes the reading and the limit that applied', async () => {
    importRecords(harness.db, siteId, [record(4.2, '2026-05-13T14:02:10.000Z')], {
      clock: harness.clock,
    });
    const id = harness.expectOk(await complaint(), 201).complaint.id;
    const response = harness.expectOk(await harness.get(`/complaints/${id}/response`, 'manager'));
    expect(response.letter).toContain('4.2 millimetres per second');
    expect(response.response.facts.limitMmPerSecond).toBeGreaterThan(4.2);
    expect(response.response.facts.overLimit).toBe(false);
  });

  it('says what is being done when the reading was over', async () => {
    importRecords(harness.db, siteId, [record(30, '2026-05-13T14:02:10.000Z')], {
      clock: harness.clock,
    });
    const id = harness.expectOk(await complaint(), 201).complaint.id;
    const response = harness.expectOk(await harness.get(`/complaints/${id}/response`, 'manager'));
    expect(response.response.facts.overLimit).toBe(true);
    expect(response.letter).toContain('reported it to the regulator');
  });

  it('offers a monitor when there is no reading at all', async () => {
    const id = harness.expectOk(await complaint(), 201).complaint.id;
    const response = harness.expectOk(await harness.get(`/complaints/${id}/response`, 'manager'));
    expect(response.letter).toContain('putting a monitor');
  });

  it('names the shot once the complaint is tied to one', async () => {
    const blastId = harness.expectOk(
      await harness.post(`/sites/${siteId}/blasts`, 'designer', { reference: 'MDW-2026-020' }),
      201,
    ).blast.id;
    harness.db
      .prepare(
        "UPDATE blast SET fired_at = '2026-05-13T14:02:00.000Z', state = 'fired' WHERE id = ?",
      )
      .run(blastId);
    const id = harness.expectOk(await complaint(), 201).complaint.id;
    await harness.post(`/complaints/${id}/blast`, 'manager', { blastId });
    const response = harness.expectOk(await harness.get(`/complaints/${id}/response`, 'manager'));
    expect(response.letter).toContain('MDW-2026-020');
  });

  it('signs it with whoever asked for it', async () => {
    const id = harness.expectOk(await complaint(), 201).complaint.id;
    const response = harness.expectOk(await harness.get(`/complaints/${id}/response`, 'manager'));
    expect(response.response.signedBy).toBe('manager');
  });

  it('answers 404 for a complaint that is not there', async () => {
    expect((await harness.get('/complaints/rep_missing/response', 'manager')).statusCode).toBe(404);
  });
});
