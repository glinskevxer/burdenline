import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';
import { parseCsvRecords } from '../../src/lib/csv.js';

let harness;
let benchId;

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

beforeEach(async () => {
  harness = await standUp();
  const site = await harness.app.inject({
    method: 'POST',
    url: '/sites',
    headers: harness.as('admin'),
    payload: { code: 'MDW', name: 'Midway' },
  });
  const bench = await harness.app.inject({
    method: 'POST',
    url: `/sites/${site.json().site.id}/benches`,
    headers: harness.as('designer'),
    payload: {
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
    },
  });
  benchId = bench.json().bench.id;
});

afterEach(async () => {
  await harness.close();
});

async function layPattern(overrides = {}) {
  return harness.app.inject({
    method: 'POST',
    url: `/benches/${benchId}/patterns`,
    headers: harness.as('designer'),
    payload: { ...layout, ...overrides },
  });
}

describe('POST /benches/:benchId/patterns', () => {
  it('lays a pattern out and answers 201', async () => {
    const response = await layPattern();
    expect(response.statusCode).toBe(201);
    expect(response.json().holeCount).toBe(8);
    expect(response.json().summary.volumeM3).toBe(1260);
  });

  it('takes the bench height from the bench', async () => {
    expect((await layPattern()).json().pattern.benchHeightM).toBe(15);
  });

  it('records who designed it from the token', async () => {
    expect((await layPattern()).json().pattern.designedBy).toBe('per_designer');
  });

  it('refuses a bearing of a full circle', async () => {
    const response = await layPattern({ faceBearingDeg: 360 });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a pattern nobody could drill', async () => {
    expect((await layPattern({ holesPerRow: 500 })).statusCode).toBe(422);
    expect((await layPattern({ burdenM: 0 })).statusCode).toBe(422);
  });

  it('refuses a single row pattern with two rows', async () => {
    const response = await layPattern({ layout: 'single_row', rowCount: 2 });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a reference already used', async () => {
    await layPattern();
    expect((await layPattern()).statusCode).toBe(409);
  });

  it('keeps a viewer out', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/benches/${benchId}/patterns`,
      headers: harness.as('viewer'),
      payload: layout,
    });
    expect(response.statusCode).toBe(403);
  });

  it('answers 404 for a bench that is not there', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/benches/bench_missing/patterns',
      headers: harness.as('designer'),
      payload: layout,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('reading a pattern', () => {
  it('reads it back with its holes', async () => {
    const patternId = (await layPattern()).json().pattern.id;
    const response = await harness.app.inject({
      method: 'GET',
      url: `/patterns/${patternId}`,
      headers: harness.as('viewer'),
    });
    expect(response.json().holes).toHaveLength(8);
  });

  it('pages the holes', async () => {
    const patternId = (await layPattern({ holesPerRow: 20 })).json().pattern.id;
    const response = await harness.app.inject({
      method: 'GET',
      url: `/patterns/${patternId}/holes?limit=10&offset=35`,
      headers: harness.as('viewer'),
    });
    expect(response.json().holes).toHaveLength(5);
    expect(response.json().total).toBe(40);
  });

  it('lists the patterns on a bench', async () => {
    await layPattern();
    await layPattern({ reference: 'MDW-2025-015' });
    const response = await harness.app.inject({
      method: 'GET',
      url: `/benches/${benchId}/patterns`,
      headers: harness.as('viewer'),
    });
    expect(response.json().patterns).toHaveLength(2);
  });
});

describe('the drill plan file', () => {
  it('comes back as a csv attachment', async () => {
    const patternId = (await layPattern()).json().pattern.id;
    const response = await harness.app.inject({
      method: 'GET',
      url: `/patterns/${patternId}/plan.csv`,
      headers: harness.as('viewer'),
    });
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('MDW-2025-014.csv');
    expect(parseCsvRecords(response.payload).records).toHaveLength(8);
  });

  it('serves the wider format for the other rig', async () => {
    const patternId = (await layPattern()).json().pattern.id;
    const response = await harness.app.inject({
      method: 'GET',
      url: `/patterns/${patternId}/plan.csv?format=collar_toe`,
      headers: harness.as('viewer'),
    });
    expect(response.payload).toContain('toe_easting');
  });

  it('summarises what the crew is being asked to drill', async () => {
    const patternId = (await layPattern()).json().pattern.id;
    const response = await harness.app.inject({
      method: 'GET',
      url: `/patterns/${patternId}/plan`,
      headers: harness.as('viewer'),
    });
    expect(response.json().summary.totalDrillingM).toBe(128);
  });
});

describe('POST /patterns/:patternId/drill-log', () => {
  const log = [
    'Hole,Depth (m),Condition,Water (m)',
    '1,16.1,dry,',
    '2,15.2,wet,3.1',
    '3,16.0,dry,',
  ].join('\n');

  it('takes the log and reconciles it against the plan', async () => {
    const patternId = (await layPattern()).json().pattern.id;
    const response = await harness.app.inject({
      method: 'POST',
      url: `/patterns/${patternId}/drill-log`,
      headers: harness.as('designer'),
      payload: { csv: log },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().written.updated).toBe(3);
    expect(response.json().reconciliation.counts.not_drilled).toBe(5);
  });

  it('writes the depths onto the holes', async () => {
    const patternId = (await layPattern()).json().pattern.id;
    await harness.app.inject({
      method: 'POST',
      url: `/patterns/${patternId}/drill-log`,
      headers: harness.as('designer'),
      payload: { csv: log },
    });
    const holes = await harness.app.inject({
      method: 'GET',
      url: `/patterns/${patternId}/holes`,
      headers: harness.as('viewer'),
    });
    const second = holes.json().holes.find((hole) => hole.holeNumber === 2);
    expect(second.drilledDepthM).toBe(15.2);
    expect(second.condition).toBe('wet');
  });

  it('refuses a log with a hole logged twice', async () => {
    const patternId = (await layPattern()).json().pattern.id;
    const response = await harness.app.inject({
      method: 'POST',
      url: `/patterns/${patternId}/drill-log`,
      headers: harness.as('designer'),
      payload: { csv: 'hole,depth\n1,16\n1,15\n' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses an empty body', async () => {
    const patternId = (await layPattern()).json().pattern.id;
    const response = await harness.app.inject({
      method: 'POST',
      url: `/patterns/${patternId}/drill-log`,
      headers: harness.as('designer'),
      payload: {},
    });
    expect(response.statusCode).toBe(422);
  });
});
