import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';
import { saveSiteLaw } from '../../src/db/repositories/monitoring.js';

let harness;
let siteId;
let patternId;

const at = '2025-10-14T09:00:00.000Z';

const layout = {
  reference: 'MDW-2025-014',
  origin: { easting: 1000, northing: 2000, level: 84 },
  faceBearingDeg: 0,
  layout: 'square',
  rowCount: 2,
  holesPerRow: 4,
  burdenM: 3,
  spacingM: 3.5,
  subdrillM: 1,
  diameterMm: 102,
};

function tieIn(holeCount, delayMs = 42) {
  return {
    initiationHole: 1,
    holes: Array.from({ length: holeCount }, (_unused, index) => ({
      holeNumber: index + 1,
      inHoleDelayMs: 500,
    })),
    connectors: Array.from({ length: holeCount - 1 }, (_unused, index) => ({
      fromHole: index + 1,
      toHole: index + 2,
      delayMs,
    })),
  };
}

async function post(url, role, payload) {
  return harness.app.inject({ method: 'POST', url, headers: harness.as(role), payload });
}

beforeEach(async () => {
  harness = await standUp({ at });
  siteId = (await post('/sites', 'admin', { code: 'MDW', name: 'Midway' })).json().site.id;
  const benchId = (
    await post(`/sites/${siteId}/benches`, 'designer', {
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
    })
  ).json().bench.id;
  patternId = (await post(`/benches/${benchId}/patterns`, 'designer', layout)).json().pattern.id;
  await post('/products', 'admin', {
    code: 'ANFO-80',
    name: 'Ammonium nitrate fuel oil',
    kind: 'bulk_anfo',
    densityKgM3: 800,
    relativeWeightStrength: 100,
    minimumDiameterMm: 50,
  });
  await post('/products', 'admin', {
    code: 'EM-115',
    name: 'Pumped emulsion',
    kind: 'bulk_emulsion',
    densityKgM3: 1150,
    relativeWeightStrength: 82,
    waterResistance: 'excellent',
    minimumDiameterMm: 76,
  });
});

afterEach(async () => {
  await harness.close();
});

describe('POST /patterns/:patternId/charge-plan', () => {
  it('plans every hole to the target', async () => {
    const response = await post(`/patterns/${patternId}/charge-plan`, 'designer', {
      powderFactorKgM3: 0.55,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().totals.holeCount).toBe(8);
    expect(response.json().totals.achievedPowderFactorKgM3).toBeCloseTo(0.55, 2);
    expect(response.json().sheet[0].product).toBe('ANFO-80');
  });

  it('saves nothing, so asking twice gives the same answer', async () => {
    const first = await post(`/patterns/${patternId}/charge-plan`, 'designer', {
      powderFactorKgM3: 0.55,
    });
    const second = await post(`/patterns/${patternId}/charge-plan`, 'designer', {
      powderFactorKgM3: 0.55,
    });
    expect(second.json()).toEqual(first.json());
    const read = await harness.app.inject({
      method: 'GET',
      url: `/patterns/${patternId}`,
      headers: harness.as('viewer'),
    });
    expect(read.json().holes.every((hole) => hole.status === 'planned')).toBe(true);
  });

  it('reports a violation rather than refusing outright', async () => {
    const response = await post(`/patterns/${patternId}/charge-plan`, 'designer', {
      powderFactorKgM3: 0.55,
      stemmingM: 1,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().violations.length).toBeGreaterThan(0);
  });

  it('refuses a powder factor nobody would fire', async () => {
    expect(
      (await post(`/patterns/${patternId}/charge-plan`, 'designer', { powderFactorKgM3: 8 }))
        .statusCode,
    ).toBe(422);
  });
});

describe('POST /patterns/:patternId/timing', () => {
  it('works the instantaneous charge out from the tie-in', async () => {
    const response = await post(`/patterns/${patternId}/timing`, 'designer', {
      powderFactorKgM3: 0.55,
      tieIn: tieIn(8),
    });
    expect(response.json().summary.maximumInstantaneousChargeKg).toBeCloseTo(86.6, 0);
    expect(response.json().firingOrder).toHaveLength(8);
    expect(response.json().violations).toEqual([]);
  });

  it('gathers the whole shot into one window when nothing is delayed', async () => {
    const response = await post(`/patterns/${patternId}/timing`, 'designer', {
      powderFactorKgM3: 0.55,
      tieIn: tieIn(8, 0),
    });
    expect(response.json().summary.maximumInstantaneousChargeKg).toBeGreaterThan(600);
    expect(response.json().violations.length).toBeGreaterThan(0);
  });

  it('refuses a tie-in with no holes in it', async () => {
    const response = await post(`/patterns/${patternId}/timing`, 'designer', {
      powderFactorKgM3: 0.55,
      tieIn: { initiationHole: 1, holes: [] },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('POST /sites/:siteId/patterns/:patternId/design', () => {
  beforeEach(async () => {
    await post(`/sites/${siteId}/receptors`, 'admin', {
      name: 'Keeper cottage',
      structureClass: 'older_dwelling',
      easting: 1400,
      northing: 2000,
    });
    saveSiteLaw(harness.db, { siteId, k: 1140, b: 1.6, recordCount: 24 }, { clock: harness.clock });
  });

  it('runs the whole design and comes back with the totals', async () => {
    const response = await post(`/sites/${siteId}/patterns/${patternId}/design`, 'designer', {
      powderFactorKgM3: 0.55,
      tieIn: tieIn(8),
      frequencyHz: 25,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().totals.holeCount).toBe(8);
    expect(response.json().vibration.compliant).toBe(true);
    expect(response.json().fragmentation.meanCm).toBeGreaterThan(0);
  });

  it('writes the totals onto a shot when one is named', async () => {
    const blastId = (
      await post(`/sites/${siteId}/blasts`, 'designer', { reference: 'MDW-2025-014-B' })
    ).json().blast.id;
    await post(`/sites/${siteId}/patterns/${patternId}/design`, 'designer', {
      powderFactorKgM3: 0.55,
      tieIn: tieIn(8),
      frequencyHz: 25,
      blastId,
    });
    const blast = await harness.app.inject({
      method: 'GET',
      url: `/blasts/${blastId}`,
      headers: harness.as('viewer'),
    });
    expect(blast.json().blast.instantaneousChargeKg).toBeCloseTo(86.6, 0);
  });

  it('answers 422 while the site has no fitted law', async () => {
    const other = (await post('/sites', 'admin', { code: 'RCK', name: 'Rockfield' })).json().site
      .id;
    const response = await post(`/sites/${other}/patterns/${patternId}/design`, 'designer', {
      powderFactorKgM3: 0.55,
      tieIn: tieIn(8),
    });
    expect(response.statusCode).toBe(422);
  });

  it('reports a vibration failure as a violation', async () => {
    await post(`/sites/${siteId}/receptors`, 'admin', {
      name: 'Gate lodge',
      structureClass: 'older_dwelling',
      easting: 1120,
      northing: 2000,
    });
    const response = await post(`/sites/${siteId}/patterns/${patternId}/design`, 'designer', {
      powderFactorKgM3: 0.55,
      tieIn: tieIn(8, 0),
      frequencyHz: 25,
    });
    expect(response.json().violations.some((item) => item.rule === 'vibration.over_limit')).toBe(
      true,
    );
    expect(response.json().vibration.reduction.needed).toBe(true);
  });
});
