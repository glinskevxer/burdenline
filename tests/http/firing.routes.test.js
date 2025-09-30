import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';
import { insertRow } from '../../src/db/repository.js';

let harness;
let siteId;
let blastId;

/** A Tuesday at two in the afternoon local time. */
const at = '2025-09-30T13:00:00.000Z';

const observation = {
  observedAt: at,
  windSpeedMs: 3,
  windBearingDeg: 90,
  temperatureC: 17,
  temperatureAt10mC: 16.2,
  visibilityM: 9000,
};

const schedule = { tuesday: [{ from: '13:00', to: '16:00' }] };

const ORDER = [
  'plant_withdrawn',
  'people_withdrawn',
  'zone_swept',
  'sentries_posted',
  'roads_stopped',
  'shot_area_clear',
  'warning_signal',
];

async function post(url, role, payload) {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: harness.as(role),
    ...(payload !== undefined ? { payload } : {}),
  });
}

beforeEach(async () => {
  harness = await standUp({ at });
  const site = await post('/sites', 'admin', {
    code: 'MDW',
    name: 'Midway',
    timeZone: 'Europe/Dublin',
  });
  siteId = site.json().site.id;
  insertRow(harness.db, 'certificate', {
    id: 'cert_1',
    personId: 'per_shotfirer',
    kind: 'shotfirer',
    issuedOn: '2023-01-15',
    expiresOn: '2028-01-15',
    endorsements: 'bulk_explosive,shock_tube_initiation',
    createdAt: at,
    updatedAt: at,
  });
  const blast = await post(`/sites/${siteId}/blasts`, 'designer', { reference: 'MDW-2025-014' });
  blastId = blast.json().blast.id;
  await post(`/blasts/${blastId}/complete-design`, 'designer');
  await post(`/blasts/${blastId}/submit`, 'designer');
  await post(`/blasts/${blastId}/approve`, 'manager');
  await post(`/blasts/${blastId}/load`, 'shotfirer');
  await post(`/blasts/${blastId}/tie-in-complete`, 'shotfirer');
});

afterEach(async () => {
  await harness.close();
});

async function walkClearance() {
  await post(`/blasts/${blastId}/clearance`, 'shotfirer');
  for (const itemKey of ORDER) {
    await post(`/blasts/${blastId}/clearance/${itemKey}`, 'shotfirer', {});
  }
}

describe('the clearance', () => {
  it('starts one and answers 201', async () => {
    const response = await post(`/blasts/${blastId}/clearance`, 'shotfirer');
    expect(response.statusCode).toBe(201);
    expect(response.json().clearance.items).toHaveLength(8);
  });

  it('refuses to start one on a shot that is not loaded', async () => {
    const other = (
      await post(`/sites/${siteId}/blasts`, 'designer', { reference: 'MDW-2025-015' })
    ).json().blast.id;
    expect((await post(`/blasts/${other}/clearance`, 'shotfirer')).statusCode).toBe(409);
  });

  it('ticks items off and reports how far through it is', async () => {
    await post(`/blasts/${blastId}/clearance`, 'shotfirer');
    await post(`/blasts/${blastId}/clearance/plant_withdrawn`, 'shotfirer', {});
    const response = await harness.app.inject({
      method: 'GET',
      url: `/blasts/${blastId}/clearance`,
      headers: harness.as('viewer'),
    });
    expect(response.json().state.completeness).toBeCloseTo(0.143, 2);
    expect(response.json().state.cleared).toBe(false);
  });

  it('refuses an item out of order', async () => {
    await post(`/blasts/${blastId}/clearance`, 'shotfirer');
    const response = await post(`/blasts/${blastId}/clearance/warning_signal`, 'shotfirer', {});
    expect(response.statusCode).toBe(422);
  });

  it('keeps a viewer from ticking items off', async () => {
    await post(`/blasts/${blastId}/clearance`, 'shotfirer');
    expect(
      (await post(`/blasts/${blastId}/clearance/plant_withdrawn`, 'viewer', {})).statusCode,
    ).toBe(403);
  });
});

describe('the gate', () => {
  it('says a prepared shot may fire', async () => {
    await walkClearance();
    const response = await post(`/blasts/${blastId}/gate`, 'shotfirer', { observation, schedule });
    expect(response.json().mayFire).toBe(true);
  });

  it('says why it may not', async () => {
    await post(`/blasts/${blastId}/clearance`, 'shotfirer');
    const response = await post(`/blasts/${blastId}/gate`, 'shotfirer', { observation, schedule });
    expect(response.json().mayFire).toBe(false);
    expect(response.json().byArea.clearance).toBeGreaterThan(0);
  });

  it('stops the shot for lightning', async () => {
    await walkClearance();
    const response = await post(`/blasts/${blastId}/gate`, 'shotfirer', {
      observation: { ...observation, lightningDistanceKm: 5 },
      schedule,
    });
    expect(response.json().blocking.some((item) => item.rule === 'weather.lightning')).toBe(true);
  });

  it('refuses a weather observation that is not one', async () => {
    await walkClearance();
    const response = await post(`/blasts/${blastId}/gate`, 'shotfirer', {
      observation: { ...observation, windBearingDeg: 400 },
      schedule,
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses an override with no reason behind it', async () => {
    await walkClearance();
    const response = await post(`/blasts/${blastId}/gate`, 'shotfirer', {
      observation,
      schedule,
      overrides: [{ rule: 'stemming.minimum', reason: 'ok' }],
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('firing', () => {
  it('fires a shot that passes the gate', async () => {
    await walkClearance();
    const response = await post(`/blasts/${blastId}/fire`, 'shotfirer', { observation, schedule });
    expect(response.statusCode).toBe(200);
    expect(response.json().blast.state).toBe('fired');
    expect(response.json().blast.shotfirerId).toBe('per_shotfirer');
  });

  it('refuses a shot that does not', async () => {
    await post(`/blasts/${blastId}/clearance`, 'shotfirer');
    const response = await post(`/blasts/${blastId}/fire`, 'shotfirer', { observation, schedule });
    expect(response.statusCode).toBe(422);
    expect(response.json().details.violations.length).toBeGreaterThan(0);
  });

  it('keeps a designer away from the firing button', async () => {
    await walkClearance();
    expect(
      (await post(`/blasts/${blastId}/fire`, 'designer', { observation, schedule })).statusCode,
    ).toBe(403);
  });

  it('records a misfire and then that it was made safe', async () => {
    await walkClearance();
    await post(`/blasts/${blastId}/fire`, 'shotfirer', { observation, schedule });
    const misfire = await post(`/blasts/${blastId}/misfire`, 'shotfirer', {
      reason: 'row three did not go',
    });
    expect(misfire.json().blast.state).toBe('misfired');
    const safe = await post(`/blasts/${blastId}/made-safe`, 'shotfirer', {
      note: 'washed out and reprimed',
    });
    expect(safe.json().blast.state).toBe('made_safe');
  });

  it('refuses a misfire with nothing written down', async () => {
    await walkClearance();
    await post(`/blasts/${blastId}/fire`, 'shotfirer', { observation, schedule });
    expect(
      (await post(`/blasts/${blastId}/misfire`, 'shotfirer', { reason: 'x' })).statusCode,
    ).toBe(422);
  });
});
