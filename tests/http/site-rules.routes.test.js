import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';

let harness;
let siteId;

async function post(url, role, payload) {
  return harness.app.inject({ method: 'POST', url, headers: harness.as(role), payload });
}

async function get(url, role) {
  return harness.app.inject({ method: 'GET', url, headers: harness.as(role) });
}

async function put(url, role, payload) {
  return harness.app.inject({ method: 'PUT', url, headers: harness.as(role), payload });
}

beforeEach(async () => {
  harness = await standUp({ at: '2026-02-18T09:00:00.000Z' });
  siteId = (await post('/sites', 'admin', { code: 'MDW', name: 'Midway' })).json().site.id;
});

afterEach(async () => {
  await harness.close();
});

describe('GET /rule-sets', () => {
  it('lists every set with its defaults', async () => {
    const response = await get('/rule-sets', 'viewer');
    expect(response.statusCode).toBe(200);
    const charge = response.json().ruleSets.find((set) => set.name === 'charge');
    expect(charge.defaults.minimumStemmingDiameters).toBe(20);
  });
});

describe('reading a site', () => {
  it('reads every set and says they are the defaults', async () => {
    const response = await get(`/sites/${siteId}/rules`, 'viewer');
    expect(response.json().rules.charge.source).toBe('default');
    expect(response.json().rules.weather.values.maximumWindSpeedMs).toBe(12);
  });

  it('reads one set with its history', async () => {
    const response = await get(`/sites/${siteId}/rules/charge`, 'viewer');
    expect(response.json().rules.source).toBe('default');
    expect(response.json().history).toEqual([]);
  });

  it('answers 422 for a set nobody has', async () => {
    expect((await get(`/sites/${siteId}/rules/catering`, 'viewer')).statusCode).toBe(422);
  });

  it('lets a shotfirer see the number they were refused against', async () => {
    expect((await get(`/sites/${siteId}/rules/charge`, 'shotfirer')).statusCode).toBe(200);
  });
});

describe('setting one', () => {
  it('takes an override with a note', async () => {
    const response = await put(`/sites/${siteId}/rules/charge`, 'admin', {
      values: { minimumStemmingDiameters: 25 },
      note: 'agreed with the regulator after the March exceedance',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().rules.values.minimumStemmingDiameters).toBe(25);
    expect(response.json().rules.source).toBe('site');
  });

  it('records who set it', async () => {
    await put(`/sites/${siteId}/rules/charge`, 'admin', {
      values: { minimumStemmingDiameters: 25 },
    });
    const response = await get(`/sites/${siteId}/rules/charge`, 'viewer');
    expect(response.json().rules.setBy).toBe('per_admin');
  });

  it('keeps the history rather than editing the row', async () => {
    await put(`/sites/${siteId}/rules/charge`, 'admin', {
      values: { minimumStemmingDiameters: 25 },
    });
    await put(`/sites/${siteId}/rules/charge`, 'admin', {
      values: { minimumStemmingDiameters: 30 },
    });
    const response = await get(`/sites/${siteId}/rules/charge`, 'viewer');
    expect(response.json().history).toHaveLength(2);
  });

  it('refuses a rule the set does not have', async () => {
    const response = await put(`/sites/${siteId}/rules/charge`, 'admin', {
      values: { minimumBeerFridges: 2 },
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a value of the wrong kind', async () => {
    const response = await put(`/sites/${siteId}/rules/weather`, 'admin', {
      values: { maximumWindSpeedMs: 'breezy' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('keeps a manager out of setting one', async () => {
    const response = await put(`/sites/${siteId}/rules/charge`, 'manager', {
      values: { minimumStemmingDiameters: 25 },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('resetting one', () => {
  it('puts a set back to the defaults', async () => {
    await put(`/sites/${siteId}/rules/charge`, 'admin', {
      values: { minimumStemmingDiameters: 25 },
    });
    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/sites/${siteId}/rules/charge`,
      headers: harness.as('admin'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().rules.values.minimumStemmingDiameters).toBe(20);
  });

  it('answers 404 when there was nothing to reset', async () => {
    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/sites/${siteId}/rules/timing`,
      headers: harness.as('admin'),
    });
    expect(response.statusCode).toBe(404);
  });
});
