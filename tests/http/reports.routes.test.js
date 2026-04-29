import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';
import { seedDemoSite } from '../../src/fixtures/demo-site.js';
import { createBlast, transition, recordDesignTotals } from '../../src/db/repositories/blasts.js';

let harness;
let siteId;
let blastId;

const at = '2025-12-24T09:00:00.000Z';
const from = '2025-12-01T00:00:00.000Z';
const to = '2025-12-31T23:59:59.000Z';

beforeEach(async () => {
  harness = await standUp({ at });
  const seeded = seedDemoSite(harness.db, { clock: harness.clock });
  siteId = seeded.site.id;
  const blast = createBlast(
    harness.db,
    { siteId, patternId: seeded.pattern.id, reference: 'MDW-2025-030' },
    { clock: harness.clock },
  );
  blastId = blast.id;
  const context = { clock: harness.clock };
  transition(harness.db, blastId, 'complete_design', {}, context);
  transition(harness.db, blastId, 'submit', {}, context);
  transition(harness.db, blastId, 'approve', { approverId: seeded.people[0].id }, context);
  recordDesignTotals(
    harness.db,
    blastId,
    { totalChargeKg: 900, instantaneousChargeKg: 86, holeCount: 24, volumeM3: 3780 },
    context,
  );
  transition(harness.db, blastId, 'load', { shotfirerId: seeded.people[2].id }, context);
  transition(harness.db, blastId, 'tie_in', {}, context);
  transition(harness.db, blastId, 'clear', { clearanceId: 'chk_1' }, context);
  transition(
    harness.db,
    blastId,
    'fire',
    { shotfirerId: seeded.people[2].id, firedAt: '2025-12-20T13:00:00.000Z' },
    context,
  );
});

afterEach(async () => {
  await harness.close();
});

describe('the shot report', () => {
  it('gathers the shot', async () => {
    const response = await harness.get(`/blasts/${blastId}/report`, 'viewer');
    expect(response.statusCode).toBe(200);
    expect(response.json().blast.reference).toBe('MDW-2025-030');
    expect(response.json().metresDrilled).toBeGreaterThan(300);
  });

  it('takes the hours a caller hands it', async () => {
    const plain = (await harness.get(`/blasts/${blastId}/report`, 'viewer')).json();
    const withLabour = (
      await harness.get(`/blasts/${blastId}/report?labourHours=8`, 'viewer')
    ).json();
    expect(withLabour.cost.parts.labour).toBeGreaterThanOrEqual(plain.cost.parts.labour);
  });

  it('answers 404 for a shot that is not there', async () => {
    expect((await harness.get('/blasts/blast_missing/report', 'viewer')).statusCode).toBe(404);
  });
});

describe('the period report', () => {
  it('rolls the month up', async () => {
    const response = await harness.get(`/sites/${siteId}/report?from=${from}&to=${to}`, 'viewer');
    expect(response.json().blastCount).toBe(1);
    expect(response.json().volumeM3).toBe(3780);
  });

  it('refuses a period with no dates on it', async () => {
    expect((await harness.get(`/sites/${siteId}/report`, 'viewer')).statusCode).toBe(422);
  });

  it('scores the period', async () => {
    const response = await harness.get(
      `/sites/${siteId}/scorecard?from=${from}&to=${to}`,
      'viewer',
    );
    expect(response.json().clean).toBe(true);
    expect(response.json().tonnes).toBeGreaterThan(0);
  });
});

describe('the regulator pack', () => {
  it('builds one with every section', async () => {
    const response = await harness.get(
      `/sites/${siteId}/regulator-pack?from=${from}&to=${to}`,
      'viewer',
    );
    const pack = response.json().pack;
    expect(pack.header.licenceNumber).toBe('EL-4471');
    expect(pack.blasting.count).toBe(1);
    expect(pack.vibration.note).toContain('No ground vibration');
    expect(pack.summary.compliant).toBe(true);
  });

  it('names who prepared it', async () => {
    const response = await harness.get(
      `/sites/${siteId}/regulator-pack?from=${from}&to=${to}`,
      'manager',
    );
    expect(response.json().pack.header.preparedBy).toBe('manager');
  });

  it('comes back as files when asked', async () => {
    const response = await harness.get(
      `/sites/${siteId}/regulator-pack?from=${from}&to=${to}&format=files`,
      'viewer',
    );
    expect(Object.keys(response.json().files)).toContain('blasts.csv');
  });

  it('carries a complaint through into the pack', async () => {
    await harness.post(`/sites/${siteId}/complaints`, 'viewer', {
      channel: 'telephone',
      about: 'vibration',
      description: 'the house shook just after two on the twentieth',
      receivedAt: '2025-12-21T09:00:00.000Z',
    });
    const response = await harness.get(
      `/sites/${siteId}/regulator-pack?from=${from}&to=${to}`,
      'viewer',
    );
    expect(response.json().pack.complaints.count).toBe(1);
  });
});

describe('the audit trail', () => {
  it('reads the history of one record', async () => {
    const response = await harness.get(`/audit/blast/${blastId}`, 'admin');
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().history)).toBe(true);
  });

  it('keeps a manager out of it', async () => {
    expect((await harness.get(`/audit/blast/${blastId}`, 'manager')).statusCode).toBe(403);
  });

  it('lists what one person did', async () => {
    await harness.post(`/sites/${siteId}/complaints`, 'viewer', {
      channel: 'telephone',
      about: 'dust',
      description: 'dust on the washing again this morning',
    });
    const response = await harness.get('/audit?actorId=per_viewer', 'admin');
    expect(response.json().entries.length).toBeGreaterThan(0);
  });
});
