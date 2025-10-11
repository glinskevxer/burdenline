import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';

let harness;
let siteId;
let receptorId;

const at = '2025-10-08T09:00:00.000Z';

function vendorFile(rows) {
  return [
    'Minimate Plus Event Report',
    'Serial Number: BE-11482',
    'Trigger Level: 0.5',
    '',
    'Date Time,Tran,Tran Freq,Vert,Vert Freq,Long,Long Freq,Air,Air Freq',
    ...rows,
    '',
  ].join('\n');
}

async function post(url, role, payload) {
  return harness.app.inject({ method: 'POST', url, headers: harness.as(role), payload });
}

async function get(url, role) {
  return harness.app.inject({ method: 'GET', url, headers: harness.as(role) });
}

beforeEach(async () => {
  harness = await standUp({ at });
  siteId = (await post('/sites', 'admin', { code: 'MDW', name: 'Midway' })).json().site.id;
  receptorId = (
    await post(`/sites/${siteId}/receptors`, 'admin', {
      name: 'Keeper cottage',
      structureClass: 'dwelling',
      easting: 1400,
      northing: 2000,
      monitored: true,
    })
  ).json().receptor.id;
});

afterEach(async () => {
  await harness.close();
});

describe('receptors', () => {
  it('creates one and lists it', async () => {
    const response = await get(`/sites/${siteId}/receptors`, 'viewer');
    expect(response.json().receptors).toHaveLength(1);
    expect(response.json().receptors[0].easting).toBe(1400);
  });

  it('refuses a structure class nobody has a curve for', async () => {
    const response = await post(`/sites/${siteId}/receptors`, 'admin', {
      name: 'Shed',
      structureClass: 'shed',
      easting: 1,
      northing: 1,
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses two receptors with the same name', async () => {
    const response = await post(`/sites/${siteId}/receptors`, 'admin', {
      name: 'Keeper cottage',
      structureClass: 'dwelling',
      easting: 1,
      northing: 1,
    });
    expect(response.statusCode).toBe(409);
  });

  it('sets a licence limit on one', async () => {
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/receptors/${receptorId}`,
      headers: harness.as('admin'),
      payload: { limitMmPerSecond: 6 },
    });
    expect(response.json().receptor.limitMmPerSecond).toBe(6);
  });

  it('filters to the monitored ones', async () => {
    await post(`/sites/${siteId}/receptors`, 'admin', {
      name: 'Council depot',
      structureClass: 'commercial',
      easting: 1600,
      northing: 2000,
    });
    const response = await get(`/sites/${siteId}/receptors?monitored=true`, 'viewer');
    expect(response.json().receptors).toHaveLength(1);
  });
});

describe('importing records', () => {
  it('detects the format and stores what is in the file', async () => {
    const response = await post(`/sites/${siteId}/monitor-records`, 'manager', {
      csv: vendorFile(['2025-10-07 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
      sourceFile: 'be11482.csv',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().format).toBe('instantel');
    expect(response.json().inserted).toBe(1);
  });

  it('counts a repeated upload as duplicates', async () => {
    const payload = {
      csv: vendorFile(['2025-10-07 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    };
    await post(`/sites/${siteId}/monitor-records`, 'manager', payload);
    const second = await post(`/sites/${siteId}/monitor-records`, 'manager', payload);
    expect(second.json().inserted).toBe(0);
    expect(second.json().duplicates).toBe(1);
  });

  it('refuses a file from nothing it recognises', async () => {
    const response = await post(`/sites/${siteId}/monitor-records`, 'manager', {
      csv: 'a,b\n1,2\n',
    });
    expect(response.statusCode).toBe(422);
  });

  it('keeps a store hand out of the import', async () => {
    const response = await post(`/sites/${siteId}/monitor-records`, 'store', {
      csv: vendorFile(['2025-10-07 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
    });
    expect(response.statusCode).toBe(403);
  });

  it('lists the records back', async () => {
    await post(`/sites/${siteId}/monitor-records`, 'manager', {
      csv: vendorFile(['2025-10-07 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    });
    const response = await get(`/sites/${siteId}/monitor-records`, 'viewer');
    expect(response.json().records).toHaveLength(1);
    expect(response.json().records[0].peakComponent).toBe('transverse');
  });
});

describe('compliance', () => {
  it('judges a quiet period as compliant', async () => {
    await post(`/sites/${siteId}/monitor-records`, 'manager', {
      csv: vendorFile(['2025-10-07 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    });
    const response = await get(`/sites/${siteId}/compliance`, 'viewer');
    expect(response.json().summary.compliant).toBe(true);
  });

  it('pulls an exceedance out', async () => {
    await post(`/sites/${siteId}/monitor-records`, 'manager', {
      csv: vendorFile(['2025-10-07 13:04:11,26.0,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    });
    const response = await get(`/sites/${siteId}/compliance`, 'viewer');
    expect(response.json().exceedances).toHaveLength(1);
    expect(response.json().summary.compliant).toBe(false);
  });
});

describe('matching to shots', () => {
  it('lists what has no shot against it', async () => {
    await post(`/sites/${siteId}/monitor-records`, 'manager', {
      csv: vendorFile(['2025-10-07 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    });
    const response = await get(`/sites/${siteId}/monitor-records/unmatched`, 'viewer');
    expect(response.json().suggestions).toHaveLength(1);
    expect(response.json().suggestions[0].matched).toBe(false);
  });
});

describe('the site law', () => {
  it('answers 409 while nothing has been fitted', async () => {
    const response = await get(`/sites/${siteId}/site-law`, 'viewer');
    expect(response.statusCode).toBe(409);
  });

  it('refuses to fit from a handful of records', async () => {
    await post(`/sites/${siteId}/monitor-records`, 'manager', {
      csv: vendorFile(['2025-10-07 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    });
    const response = await post(`/sites/${siteId}/site-law`, 'manager', {});
    expect(response.statusCode).toBe(422);
  });

  it('refuses a confidence it has no factor for', async () => {
    const response = await post(`/sites/${siteId}/site-law`, 'manager', { confidence: 0.975 });
    expect(response.statusCode).toBe(422);
  });
});
