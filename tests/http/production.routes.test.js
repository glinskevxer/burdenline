import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';

let harness;
let siteId;
let blastId;

const at = '2026-02-02T09:00:00.000Z';

async function firedBlast() {
  const blast = (
    await harness.post(`/sites/${siteId}/blasts`, 'designer', { reference: 'MDW-2026-010' })
  ).json().blast.id;
  await harness.post(`/blasts/${blast}/complete-design`, 'designer');
  await harness.post(`/blasts/${blast}/submit`, 'designer');
  await harness.post(`/blasts/${blast}/approve`, 'manager');
  await harness.app.inject({
    method: 'PUT',
    url: `/blasts/${blast}/totals`,
    headers: harness.as('designer'),
    payload: { volumeM3: 3780, holeCount: 24 },
  });
  await harness.post(`/blasts/${blast}/load`, 'shotfirer');
  await harness.post(`/blasts/${blast}/tie-in-complete`, 'shotfirer');
  harness.db.prepare("UPDATE blast SET state = 'fired', fired_at = ? WHERE id = ?").run(at, blast);
  return blast;
}

beforeEach(async () => {
  harness = await standUp({ at });
  siteId = (await harness.post('/sites', 'admin', { code: 'MDW', name: 'Midway' })).json().site.id;
  blastId = await firedBlast();
});

afterEach(async () => {
  await harness.close();
});

describe('surveys', () => {
  it('records one and works out the overbreak', async () => {
    const response = await harness.post(`/blasts/${blastId}/surveys`, 'designer', {
      method: 'laser_scan',
      volumeM3: 3900,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().survey.overbreakM3).toBe(120);
  });

  it('refuses a method nobody surveys with', async () => {
    const response = await harness.post(`/blasts/${blastId}/surveys`, 'designer', {
      method: 'pacing',
      volumeM3: 3900,
    });
    expect(response.statusCode).toBe(422);
  });

  it('lists them and says which one to believe', async () => {
    await harness.post(`/blasts/${blastId}/surveys`, 'designer', {
      method: 'truck_count',
      volumeM3: 4100,
    });
    await harness.post(`/blasts/${blastId}/surveys`, 'designer', {
      method: 'laser_scan',
      volumeM3: 3900,
      surveyedAt: '2026-02-03T09:00:00.000Z',
    });
    const response = await harness.get(`/blasts/${blastId}/surveys`, 'viewer');
    expect(response.json().surveys).toHaveLength(2);
    expect(response.json().preferred.method).toBe('laser_scan');
  });

  it('keeps a viewer from recording one', async () => {
    expect(
      (
        await harness.post(`/blasts/${blastId}/surveys`, 'viewer', {
          method: 'laser_scan',
          volumeM3: 1,
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('digging', () => {
  async function inspect() {
    return harness.post(`/blasts/${blastId}/inspection`, 'shotfirer', {
      muckpileShape: 'moderate',
      throwM: 12,
      toeGrade: 'none',
    });
  }

  it('refuses a dig record before the muckpile is walked', async () => {
    const response = await harness.post(`/blasts/${blastId}/dig-records`, 'viewer', {
      tonnes: 1400,
      hours: 8,
    });
    expect(response.statusCode).toBe(409);
  });

  it('takes one once it has been', async () => {
    await inspect();
    const response = await harness.post(`/blasts/${blastId}/dig-records`, 'viewer', {
      tonnes: 1400,
      hours: 8,
    });
    expect(response.statusCode).toBe(201);
  });

  it('reports the rate', async () => {
    await inspect();
    await harness.post(`/blasts/${blastId}/dig-records`, 'viewer', { tonnes: 1400, hours: 8 });
    await harness.post(`/blasts/${blastId}/dig-records`, 'viewer', {
      tonnes: 1650,
      hours: 9,
      recordedOn: '2026-02-03',
      delayMinutes: 30,
      delayReason: 'crusher stopped',
    });
    const response = await harness.get(`/blasts/${blastId}/digging`, 'viewer');
    expect(response.json().rate.tonnes).toBe(3050);
    expect(response.json().rate.delaysByReason['crusher stopped']).toBe(30);
  });

  it('refuses a record with no hours in it', async () => {
    await inspect();
    expect(
      (await harness.post(`/blasts/${blastId}/dig-records`, 'viewer', { tonnes: 100, hours: 0 }))
        .statusCode,
    ).toBe(422);
  });
});

describe('secondary breaking and yield', () => {
  it('records a day with the hammer', async () => {
    const response = await harness.post(`/blasts/${blastId}/secondary-breaking`, 'viewer', {
      method: 'hydraulic_hammer',
      boulderCount: 14,
      hours: 6,
    });
    expect(response.statusCode).toBe(201);
  });

  it('puts the yield together', async () => {
    await harness.post(`/blasts/${blastId}/surveys`, 'designer', {
      method: 'laser_scan',
      volumeM3: 3900,
    });
    await harness.post(`/blasts/${blastId}/secondary-breaking`, 'viewer', {
      method: 'hydraulic_hammer',
      hours: 6,
    });
    const response = await harness.get(`/blasts/${blastId}/yield`, 'viewer');
    expect(response.json().yield.volume.verdict).toBe('as_designed');
    expect(response.json().secondaryBreaking.hours).toBe(6);
  });

  it('compares the weighbridge when it is given one', async () => {
    await harness.post(`/blasts/${blastId}/surveys`, 'designer', {
      method: 'laser_scan',
      volumeM3: 1000,
    });
    const response = await harness.get(`/blasts/${blastId}/yield?truckedTonnes=2650`, 'viewer');
    expect(response.json().yield.tonnage.withinTolerance).toBe(true);
  });

  it('lists what was surveyed in a period', async () => {
    await harness.post(`/blasts/${blastId}/surveys`, 'designer', {
      method: 'laser_scan',
      volumeM3: 3900,
    });
    const response = await harness.get(
      `/sites/${siteId}/surveys?from=2026-01-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z`,
      'viewer',
    );
    expect(response.json().surveys[0].reference).toBe('MDW-2026-010');
  });

  it('refuses a period with no dates', async () => {
    expect((await harness.get(`/sites/${siteId}/surveys`, 'viewer')).statusCode).toBe(422);
  });
});
