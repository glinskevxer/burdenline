import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';

let harness;
let siteId;
let blastId;

const at = '2025-12-18T13:00:00.000Z';

async function post(url, role, payload) {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: harness.as(role),
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function get(url, role) {
  return harness.app.inject({ method: 'GET', url, headers: harness.as(role) });
}

async function firedBlast(reference = 'MDW-2025-014') {
  const blast = (await post(`/sites/${siteId}/blasts`, 'designer', { reference })).json().blast.id;
  await post(`/blasts/${blast}/complete-design`, 'designer');
  await post(`/blasts/${blast}/submit`, 'designer');
  await post(`/blasts/${blast}/approve`, 'manager');
  await post(`/blasts/${blast}/load`, 'shotfirer');
  await post(`/blasts/${blast}/tie-in-complete`, 'shotfirer');
  harness.db
    .prepare("UPDATE blast SET state = 'fired', fired_at = ?, hole_count = 24 WHERE id = ?")
    .run(at, blast);
  return blast;
}

beforeEach(async () => {
  harness = await standUp({ at });
  siteId = (await post('/sites', 'admin', { code: 'MDW', name: 'Midway' })).json().site.id;
  await post(`/sites/${siteId}/receptors`, 'admin', {
    name: 'Keeper cottage',
    structureClass: 'dwelling',
    easting: 300,
    northing: 0,
  });
  blastId = await firedBlast();
});

afterEach(async () => {
  await harness.close();
});

const inspection = {
  muckpileShape: 'moderate',
  throwM: 12,
  toeGrade: 'none',
  backbreakM: 0.8,
  oversizeCount: 4,
};

describe('inspections', () => {
  it('records one and scores it', async () => {
    const response = await post(`/blasts/${blastId}/inspection`, 'shotfirer', inspection);
    expect(response.statusCode).toBe(201);
    expect(response.json().score.grade).toBe('good');
  });

  it('refuses a second one', async () => {
    await post(`/blasts/${blastId}/inspection`, 'shotfirer', inspection);
    expect((await post(`/blasts/${blastId}/inspection`, 'shotfirer', inspection)).statusCode).toBe(
      409,
    );
  });

  it('refuses a muckpile shape nobody records', async () => {
    const response = await post(`/blasts/${blastId}/inspection`, 'shotfirer', {
      ...inspection,
      muckpileShape: 'flat',
    });
    expect(response.statusCode).toBe(422);
  });

  it('keeps a viewer from recording one', async () => {
    expect((await post(`/blasts/${blastId}/inspection`, 'viewer', inspection)).statusCode).toBe(
      403,
    );
  });

  it('reads it back with the diggability', async () => {
    await post(`/blasts/${blastId}/inspection`, 'shotfirer', inspection);
    const response = await get(`/blasts/${blastId}/inspection`, 'viewer');
    expect(response.json().inspection.throwM).toBe(12);
    expect(response.json().diggability.diggable).toBe(true);
  });

  it('says the muckpile cannot be dug before anybody walked it', async () => {
    const response = await get(`/blasts/${blastId}/inspection`, 'viewer');
    expect(response.json().inspection).toBe(null);
    expect(response.json().diggability.diggable).toBe(false);
  });

  it('lists them for the site', async () => {
    await post(`/blasts/${blastId}/inspection`, 'shotfirer', inspection);
    expect((await get(`/sites/${siteId}/inspections`, 'viewer')).json().inspections).toHaveLength(
      1,
    );
  });
});

describe('misfires', () => {
  const misfire = {
    holeNumbers: [14, 15],
    kind: 'unfired_hole',
    description: 'two holes in row three are standing with the tube unfired',
  };

  it('records one against the shot', async () => {
    const response = await post(`/blasts/${blastId}/misfires`, 'shotfirer', misfire);
    expect(response.statusCode).toBe(201);
    expect(response.json().misfire.holeNumbers).toBe('14,15');
  });

  it('refuses one with nothing written down', async () => {
    const response = await post(`/blasts/${blastId}/misfires`, 'shotfirer', {
      ...misfire,
      description: 'bad',
    });
    expect(response.statusCode).toBe(422);
  });

  it('holds the muckpile until it is made safe', async () => {
    await post(`/blasts/${blastId}/inspection`, 'shotfirer', inspection);
    const written = (await post(`/blasts/${blastId}/misfires`, 'shotfirer', misfire)).json()
      .misfire;
    expect((await get(`/blasts/${blastId}/inspection`, 'viewer')).json().diggability.diggable).toBe(
      false,
    );
    await post(`/misfires/${written.id}/made-safe`, 'shotfirer');
    expect((await get(`/blasts/${blastId}/inspection`, 'viewer')).json().diggability.diggable).toBe(
      true,
    );
  });

  it('refuses to make the same one safe twice', async () => {
    const written = (await post(`/blasts/${blastId}/misfires`, 'shotfirer', misfire)).json()
      .misfire;
    await post(`/misfires/${written.id}/made-safe`, 'shotfirer');
    expect((await post(`/misfires/${written.id}/made-safe`, 'shotfirer')).statusCode).toBe(409);
  });
});

describe('notifications', () => {
  it('plans the list off the receptor register', async () => {
    const response = await post(`/blasts/${blastId}/notifications`, 'shotfirer', {
      plannedFor: at,
      radiusM: 1000,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().count).toBe(1);
  });

  it('reads them back with a summary', async () => {
    await post(`/blasts/${blastId}/notifications`, 'shotfirer', { plannedFor: at, radiusM: 1000 });
    const response = await get(`/blasts/${blastId}/notifications`, 'viewer');
    expect(response.json().summary.outstanding).toBe(1);
  });

  it('marks one sent', async () => {
    await post(`/blasts/${blastId}/notifications`, 'shotfirer', { plannedFor: at, radiusM: 1000 });
    const [notification] = (await get(`/blasts/${blastId}/notifications`, 'viewer')).json()
      .notifications;
    const response = await post(`/notifications/${notification.id}/outcome`, 'shotfirer', {
      sent: true,
    });
    expect(response.json().notification.state).toBe('sent');
  });

  it('marks one failed with a reason', async () => {
    await post(`/blasts/${blastId}/notifications`, 'shotfirer', { plannedFor: at, radiusM: 1000 });
    const [notification] = (await get(`/blasts/${blastId}/notifications`, 'viewer')).json()
      .notifications;
    const response = await post(`/notifications/${notification.id}/outcome`, 'shotfirer', {
      sent: false,
      reason: 'the number was out of service',
    });
    expect(response.json().notification.failureReason).toContain('out of service');
  });
});
