/**
 * What the server does with a request that is trying it on.
 *
 * None of these are hypothetical. A body limit exists because a rig integration
 * once posted a whole shift of telemetry to the drill log route; the array
 * bounds exist because a client with an off by one sent two hundred thousand
 * connectors; and the string bounds exist because somebody pasted a spreadsheet
 * into a note field.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';

let harness;
let siteId;
let benchId;

beforeEach(async () => {
  harness = await standUp({ at: '2026-05-25T09:00:00.000Z' });
  siteId = harness.expectOk(
    await harness.post('/sites', 'admin', { code: 'MDW', name: 'Midway' }),
    201,
  ).site.id;
  benchId = harness.expectOk(
    await harness.post(`/sites/${siteId}/benches`, 'designer', {
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
    }),
    201,
  ).bench.id;
});

afterEach(async () => {
  await harness.close();
});

describe('the size of a request', () => {
  it('refuses a body over the limit rather than reading it', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/patterns/pat_x/drill-log`,
      headers: harness.as('designer'),
      payload: { csv: 'x'.repeat(2 * 1024 * 1024) },
    });
    expect(response.statusCode).toBe(413);
  });

  it('takes a drill log of an ordinary size', async () => {
    const pattern = harness.expectOk(
      await harness.post(`/benches/${benchId}/patterns`, 'designer', {
        reference: 'MDW-2026-030',
        origin: { easting: 1000, northing: 2000, level: 84 },
        faceBearingDeg: 0,
        layout: 'square',
        rowCount: 2,
        holesPerRow: 4,
        burdenM: 3,
        spacingM: 3.5,
        diameterMm: 102,
      }),
      201,
    ).pattern;
    const csv = [
      'hole,depth',
      ...Array.from({ length: 8 }, (_unused, index) => `${index + 1},16`),
    ].join('\n');
    const response = await harness.post(`/patterns/${pattern.id}/drill-log`, 'designer', { csv });
    expect(response.statusCode).toBe(200);
  });
});

describe('the shape of a request', () => {
  it('refuses a body that is not an object', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/sites',
      headers: { ...harness.as('admin'), 'content-type': 'application/json' },
      payload: '"just a string"',
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses json that does not parse', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/sites',
      headers: { ...harness.as('admin'), 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a string far longer than the field allows', async () => {
    const response = await harness.post('/sites', 'admin', {
      code: 'RCK',
      name: 'x'.repeat(5000),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().details.issues[0].path).toBe('name');
  });

  it('refuses an array longer than the route allows', async () => {
    const blast = harness.expectOk(
      await harness.post(`/sites/${siteId}/blasts`, 'designer', { reference: 'MDW-2026-031' }),
      201,
    ).blast;
    const connectors = Array.from({ length: 20 }, (_unused, index) => ({
      fromHole: index + 1,
      toHole: index + 2,
      delayMs: 25,
      detonatorCode: 'x'.repeat(40),
    }));
    const response = await harness.put(`/blasts/${blast.id}/tie-in`, 'designer', { connectors });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a number outside the range whatever the client thinks', async () => {
    const response = await harness.post(`/sites/${siteId}/benches`, 'designer', {
      name: 'East 45',
      crestLevelM: 69,
      toeLevelM: 57,
      rockType: 'limestone',
      rockDensityKgM3: 1e9,
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a query string parameter that is not a date', async () => {
    const response = await harness.get(`/sites/${siteId}/report?from=&to=`, 'manager');
    expect(response.statusCode).toBe(422);
  });
});

describe('what a refusal says', () => {
  it('names the field and nothing else', async () => {
    const response = await harness.post('/sites', 'admin', { code: 'lowercase', name: 'Midway' });
    const problem = response.json();
    expect(problem.details.issues[0].path).toBe('code');
    expect(problem.detail).toBe('the request did not validate');
    expect(JSON.stringify(problem)).not.toContain('sqlite');
  });

  it('carries the request id so a caller can be matched to a log line', async () => {
    const response = await harness.post('/sites', 'admin', { code: 'x', name: 'y' });
    expect(response.json().requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers a method nobody serves with a problem document', async () => {
    const response = await harness.app.inject({
      method: 'DELETE',
      url: '/sites',
      headers: harness.as('admin'),
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });
});
