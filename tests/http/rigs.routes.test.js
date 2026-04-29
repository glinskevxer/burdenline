import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';

let harness;
let siteId;
let benchId;

async function rig(overrides = {}) {
  return harness.post(`/sites/${siteId}/rigs`, 'admin', {
    fleetNumber: 'DR-01',
    make: 'Atlas',
    holeDiameterMinMm: 89,
    holeDiameterMaxMm: 115,
    ...overrides,
  });
}

async function pattern(diameter = 102, reference = 'MDW-2026-030') {
  const response = await harness.post(`/benches/${benchId}/patterns`, 'designer', {
    reference,
    origin: { easting: 1000, northing: 2000, level: 84 },
    faceBearingDeg: 0,
    layout: 'square',
    rowCount: 1,
    holesPerRow: 4,
    burdenM: 3,
    spacingM: 3.5,
    subdrillM: 1,
    diameterMm: diameter,
  });
  return response.json().pattern.id;
}

beforeEach(async () => {
  harness = await standUp({ at: '2026-02-24T06:00:00.000Z' });
  siteId = (await harness.post('/sites', 'admin', { code: 'MDW', name: 'Midway' })).json().site.id;
  benchId = (
    await harness.post(`/sites/${siteId}/benches`, 'designer', {
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
    })
  ).json().bench.id;
});

afterEach(async () => {
  await harness.close();
});

describe('the fleet', () => {
  it('creates a rig and lists it', async () => {
    expect((await rig()).statusCode).toBe(201);
    const response = await harness.get(`/sites/${siteId}/rigs`, 'viewer');
    expect(response.json().rigs).toHaveLength(1);
    expect(response.json().rigs[0].status).toBe('available');
  });

  it('refuses a diameter range that runs backwards', async () => {
    expect((await rig({ holeDiameterMaxMm: 50 })).statusCode).toBe(422);
  });

  it('refuses two rigs with the same fleet number', async () => {
    await rig();
    expect((await rig()).statusCode).toBe(409);
  });

  it('keeps a designer from creating one', async () => {
    const response = await harness.post(`/sites/${siteId}/rigs`, 'designer', {
      fleetNumber: 'DR-02',
      holeDiameterMinMm: 89,
      holeDiameterMaxMm: 115,
    });
    expect(response.statusCode).toBe(403);
  });

  it('takes a rig out of service and back', async () => {
    const rigId = (await rig()).json().rig.id;
    const down = await harness.app.inject({
      method: 'PATCH',
      url: `/rigs/${rigId}`,
      headers: harness.as('designer'),
      payload: { status: 'down' },
    });
    expect(down.json().rig.status).toBe('down');
    expect(
      (await harness.get(`/sites/${siteId}/rigs?status=down`, 'viewer')).json().rigs,
    ).toHaveLength(1);
  });

  it('retires one and then refuses', async () => {
    const rigId = (await rig()).json().rig.id;
    expect((await harness.post(`/rigs/${rigId}/retire`, 'admin')).json().rig.status).toBe(
      'retired',
    );
    expect((await harness.post(`/rigs/${rigId}/retire`, 'admin')).statusCode).toBe(409);
  });
});

describe('matching a rig to a pattern', () => {
  it('says which rigs can drill it', async () => {
    await rig();
    const patternId = await pattern(102);
    const response = await harness.get(`/patterns/${patternId}/rigs`, 'viewer');
    expect(response.json().suitable).toHaveLength(1);
    expect(response.json().unsuitable).toHaveLength(0);
  });

  it('says why a rig cannot', async () => {
    await rig({ holeDiameterMinMm: 76, holeDiameterMaxMm: 89 });
    const patternId = await pattern(115, 'MDW-2026-031');
    const response = await harness.get(`/patterns/${patternId}/rigs`, 'viewer');
    expect(response.json().suitable).toHaveLength(0);
    expect(response.json().unsuitable[0].reasons[0]).toContain('76 to 89');
  });
});

describe('shifts', () => {
  it('records one and adds the hours onto the rig', async () => {
    const rigId = (await rig()).json().rig.id;
    const response = await harness.post(`/rigs/${rigId}/shifts`, 'viewer', {
      shift: 'day',
      metresDrilled: 220,
      holesDrilled: 14,
      hours: 8,
    });
    expect(response.statusCode).toBe(201);
    expect((await harness.get(`/sites/${siteId}/rigs`, 'viewer')).json().rigs[0].hoursRun).toBe(8);
  });

  it('refuses two records for the same shift', async () => {
    const rigId = (await rig()).json().rig.id;
    const shift = { shift: 'day', shiftDate: '2026-02-24', hours: 8 };
    await harness.post(`/rigs/${rigId}/shifts`, 'viewer', shift);
    expect((await harness.post(`/rigs/${rigId}/shifts`, 'viewer', shift)).statusCode).toBe(409);
  });

  it('refuses a shift longer than a day', async () => {
    const rigId = (await rig()).json().rig.id;
    expect(
      (await harness.post(`/rigs/${rigId}/shifts`, 'viewer', { shift: 'day', hours: 30 }))
        .statusCode,
    ).toBe(422);
  });

  it('reports metres per drilling hour', async () => {
    const rigId = (await rig()).json().rig.id;
    await harness.post(`/rigs/${rigId}/shifts`, 'viewer', {
      shift: 'day',
      metresDrilled: 220,
      hours: 8,
      downtimeMinutes: 60,
      downtimeReason: 'bit change',
    });
    const response = await harness.get(`/rigs/${rigId}/shifts`, 'viewer');
    expect(response.json().productivity.metresPerHour).toBeCloseTo(31.43, 2);
    expect(response.json().productivity.downtimeByReason['bit change']).toBe(60);
  });
});
