import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';

let harness;
let siteId;

beforeEach(async () => {
  harness = await standUp();
  const site = await harness.app.inject({
    method: 'POST',
    url: '/sites',
    headers: harness.as('admin'),
    payload: { code: 'MDW', name: 'Midway' },
  });
  siteId = site.json().site.id;
});

afterEach(async () => {
  await harness.close();
});

async function createBlast(overrides = {}) {
  return harness.app.inject({
    method: 'POST',
    url: `/sites/${siteId}/blasts`,
    headers: harness.as('designer'),
    payload: { reference: 'MDW-2025-014', ...overrides },
  });
}

async function post(url, role, payload) {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: harness.as(role),
    ...(payload ? { payload } : {}),
  });
}

describe('POST /sites/:siteId/blasts', () => {
  it('creates a shot in draft', async () => {
    const response = await createBlast();
    expect(response.statusCode).toBe(201);
    expect(response.json().blast.state).toBe('draft');
    expect(response.json().next).toContain('complete_design');
  });

  it('records who designed it', async () => {
    expect((await createBlast()).json().blast.designedBy).toBe('per_designer');
  });

  it('refuses a reference already used', async () => {
    await createBlast();
    expect((await createBlast()).statusCode).toBe(409);
  });

  it('answers 404 for a site that is not there', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/sites/site_missing/blasts',
      headers: harness.as('designer'),
      payload: { reference: 'MDW-2025-099' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('the lifecycle routes', () => {
  it('walks a shot from draft to approved', async () => {
    const blastId = (await createBlast()).json().blast.id;
    expect((await post(`/blasts/${blastId}/complete-design`, 'designer')).json().blast.state).toBe(
      'designed',
    );
    expect((await post(`/blasts/${blastId}/submit`, 'designer')).json().blast.state).toBe(
      'submitted',
    );
    const approved = await post(`/blasts/${blastId}/approve`, 'manager');
    expect(approved.json().blast.state).toBe('approved');
    expect(approved.json().blast.approvedBy).toBe('per_manager');
  });

  it('refuses a move that is not allowed from here', async () => {
    const blastId = (await createBlast()).json().blast.id;
    const response = await post(`/blasts/${blastId}/approve`, 'manager');
    expect(response.statusCode).toBe(409);
    expect(response.json().details.allowed).toEqual(['submitted']);
  });

  it('will not let a designer approve their own shot', async () => {
    const blastId = (await createBlast()).json().blast.id;
    await post(`/blasts/${blastId}/complete-design`, 'designer');
    await post(`/blasts/${blastId}/submit`, 'designer');
    expect((await post(`/blasts/${blastId}/approve`, 'designer')).statusCode).toBe(403);
  });

  it('needs a reason to reject', async () => {
    const blastId = (await createBlast()).json().blast.id;
    await post(`/blasts/${blastId}/complete-design`, 'designer');
    await post(`/blasts/${blastId}/submit`, 'designer');
    expect((await post(`/blasts/${blastId}/reject`, 'manager', {})).statusCode).toBe(422);
    const rejected = await post(`/blasts/${blastId}/reject`, 'manager', {
      reason: 'burden on row one is too thin',
    });
    expect(rejected.json().blast.state).toBe('designed');
  });

  it('needs a reason to abandon', async () => {
    const blastId = (await createBlast()).json().blast.id;
    const response = await post(`/blasts/${blastId}/abandon`, 'manager', {
      reason: 'face changed',
    });
    expect(response.json().blast.state).toBe('abandoned');
    expect(response.json().next).toEqual([]);
  });

  it('says what can happen next after every move', async () => {
    const blastId = (await createBlast()).json().blast.id;
    const response = await post(`/blasts/${blastId}/complete-design`, 'designer');
    expect(response.json().next.sort()).toEqual(['abandon', 'revise', 'submit']);
  });
});

describe('GET /blasts/:blastId', () => {
  it('reads the shot with its history', async () => {
    const blastId = (await createBlast()).json().blast.id;
    await post(`/blasts/${blastId}/complete-design`, 'designer');
    const response = await harness.app.inject({
      method: 'GET',
      url: `/blasts/${blastId}`,
      headers: harness.as('viewer'),
    });
    expect(response.json().events).toHaveLength(1);
    expect(response.json().stateDescription).toContain('design finished');
  });

  it('lists the shots on a site by state', async () => {
    await createBlast();
    const second = (await createBlast({ reference: 'MDW-2025-015' })).json().blast.id;
    await post(`/blasts/${second}/complete-design`, 'designer');
    const response = await harness.app.inject({
      method: 'GET',
      url: `/sites/${siteId}/blasts?state=designed`,
      headers: harness.as('viewer'),
    });
    expect(response.json().blasts).toHaveLength(1);
  });

  it('answers 404 for a shot that is not there', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/blasts/blast_missing',
      headers: harness.as('viewer'),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('the tie-in', () => {
  it('takes a tie-in and reads it back', async () => {
    const blastId = (await createBlast()).json().blast.id;
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/blasts/${blastId}/tie-in`,
      headers: harness.as('designer'),
      payload: {
        connectors: [
          { fromHole: 1, toHole: 2, delayMs: 25, detonatorCode: 'SC-25' },
          { fromHole: 2, toHole: 3, delayMs: 25 },
        ],
      },
    });
    expect(response.json().connectorCount).toBe(2);
    const read = await harness.app.inject({
      method: 'GET',
      url: `/blasts/${blastId}`,
      headers: harness.as('viewer'),
    });
    expect(read.json().tieIn).toHaveLength(2);
  });

  it('refuses a connector with a negative delay', async () => {
    const blastId = (await createBlast()).json().blast.id;
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/blasts/${blastId}/tie-in`,
      headers: harness.as('designer'),
      payload: { connectors: [{ fromHole: 1, toHole: 2, delayMs: -5 }] },
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses an empty tie-in', async () => {
    const blastId = (await createBlast()).json().blast.id;
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/blasts/${blastId}/tie-in`,
      headers: harness.as('designer'),
      payload: { connectors: [] },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('the design totals', () => {
  it('writes them onto the shot', async () => {
    const blastId = (await createBlast()).json().blast.id;
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/blasts/${blastId}/totals`,
      headers: harness.as('designer'),
      payload: { totalChargeKg: 520, instantaneousChargeKg: 86, holeCount: 24 },
    });
    expect(response.json().blast.instantaneousChargeKg).toBe(86);
  });

  it('refuses a negative charge', async () => {
    const blastId = (await createBlast()).json().blast.id;
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/blasts/${blastId}/totals`,
      headers: harness.as('designer'),
      payload: { totalChargeKg: -1 },
    });
    expect(response.statusCode).toBe(422);
  });
});
