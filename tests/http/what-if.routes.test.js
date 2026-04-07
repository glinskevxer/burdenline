import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';
import { saveSiteLaw } from '../../src/db/repositories/monitoring.js';

let harness;
let siteId;

const base = {
  origin: { easting: 1000, northing: 2000, level: 84 },
  faceBearingDeg: 0,
  layout: 'staggered',
  rowCount: 3,
  holesPerRow: 8,
  burdenM: 3.2,
  spacingM: 3.6,
  benchHeightM: 15,
  subdrillM: 1,
  diameterMm: 102,
};

async function post(url, role, payload) {
  return harness.app.inject({ method: 'POST', url, headers: harness.as(role), payload });
}

beforeEach(async () => {
  harness = await standUp({ at: '2026-04-08T09:00:00.000Z' });
  siteId = (await post('/sites', 'admin', { code: 'MDW', name: 'Midway' })).json().site.id;
  await post('/products', 'admin', {
    code: 'ANFO-80',
    name: 'Ammonium nitrate fuel oil',
    kind: 'bulk_anfo',
    densityKgM3: 800,
    relativeWeightStrength: 100,
    minimumDiameterMm: 50,
  });
  saveSiteLaw(harness.db, { siteId, k: 1140, b: 1.6, recordCount: 30 }, { clock: harness.clock });
});

afterEach(async () => {
  await harness.close();
});

describe('POST /sites/:siteId/what-if', () => {
  it('compares two designs', async () => {
    const response = await post(`/sites/${siteId}/what-if`, 'designer', {
      base,
      alternative: { ...base, burdenM: 2.8, spacingM: 3.2 },
      powderFactorKgM3: 0.55,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().verdict.finer).toBe('alternative');
    expect(response.json().differences.length).toBeGreaterThan(5);
  });

  it('predicts the vibration off the fitted law', async () => {
    const response = await post(`/sites/${siteId}/what-if`, 'designer', {
      base,
      alternative: { ...base, holesPerRow: 4 },
      powderFactorKgM3: 0.55,
      receptorDistanceM: 300,
    });
    expect(response.json().base.predictedPpvMmPerSecond).toBeGreaterThan(0);
  });

  it('refuses a design that is missing a dimension', async () => {
    const response = await post(`/sites/${siteId}/what-if`, 'designer', {
      base: { ...base, burdenM: undefined },
      alternative: base,
      powderFactorKgM3: 0.55,
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a field nobody defined on a design', async () => {
    const response = await post(`/sites/${siteId}/what-if`, 'designer', {
      base: { ...base, colour: 'blue' },
      alternative: base,
      powderFactorKgM3: 0.55,
    });
    expect(response.statusCode).toBe(422);
  });

  it('keeps a viewer out', async () => {
    const response = await post(`/sites/${siteId}/what-if`, 'viewer', {
      base,
      alternative: base,
      powderFactorKgM3: 0.55,
    });
    expect(response.statusCode).toBe(403);
  });

  it('says nothing about the vibration on a site with no law', async () => {
    const other = (await post('/sites', 'admin', { code: 'RCK', name: 'Rockfield' })).json().site
      .id;
    const response = await post(`/sites/${other}/what-if`, 'designer', {
      base,
      alternative: { ...base, burdenM: 3 },
      powderFactorKgM3: 0.55,
    });
    expect(response.json().verdict.quieter).toBe('unknown');
  });
});
