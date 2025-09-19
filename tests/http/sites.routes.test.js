import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';

let harness;

beforeEach(async () => {
  harness = await standUp();
});

afterEach(async () => {
  await harness.close();
});

async function createSite(overrides = {}) {
  return harness.app.inject({
    method: 'POST',
    url: '/sites',
    headers: harness.as('admin'),
    payload: { code: 'MDW', name: 'Midway', timeZone: 'Europe/Dublin', ...overrides },
  });
}

async function createBench(siteId, overrides = {}) {
  return harness.app.inject({
    method: 'POST',
    url: `/sites/${siteId}/benches`,
    headers: harness.as('designer'),
    payload: {
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
      ...overrides,
    },
  });
}

describe('POST /sites', () => {
  it('creates one and answers 201', async () => {
    const response = await createSite();
    expect(response.statusCode).toBe(201);
    expect(response.json().site.code).toBe('MDW');
  });

  it('refuses a lowercase code at the schema', async () => {
    const response = await createSite({ code: 'mdw' });
    expect(response.statusCode).toBe(422);
    expect(response.json().details.issues[0].path).toBe('code');
  });

  it('refuses a field nobody defined', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/sites',
      headers: harness.as('admin'),
      payload: { code: 'MDW', name: 'Midway', colour: 'blue' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('answers 409 for a code already in use', async () => {
    await createSite();
    const response = await createSite({ name: 'Midway lower' });
    expect(response.statusCode).toBe(409);
  });

  it('keeps a designer out of creating a site', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/sites',
      headers: harness.as('designer'),
      payload: { code: 'RCK', name: 'Rockfield' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /sites', () => {
  it('lists them for anybody who can read', async () => {
    await createSite();
    const response = await harness.app.inject({
      method: 'GET',
      url: '/sites',
      headers: harness.as('viewer'),
    });
    expect(response.json().sites).toHaveLength(1);
  });

  it('refuses without a token', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/sites' });
    expect(response.statusCode).toBe(401);
  });

  it('reads one back with its benches', async () => {
    const siteId = (await createSite()).json().site.id;
    await createBench(siteId);
    const response = await harness.app.inject({
      method: 'GET',
      url: `/sites/${siteId}`,
      headers: harness.as('viewer'),
    });
    expect(response.json().site.name).toBe('Midway');
    expect(response.json().benches).toHaveLength(1);
  });

  it('answers 404 for a site that is not there', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/sites/site_missing',
      headers: harness.as('viewer'),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().details.kind).toBe('site');
  });
});

describe('PATCH /sites/:siteId', () => {
  it('renames a site', async () => {
    const siteId = (await createSite()).json().site.id;
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/sites/${siteId}`,
      headers: harness.as('admin'),
      payload: { name: 'Midway Quarry' },
    });
    expect(response.json().site.name).toBe('Midway Quarry');
  });

  it('will not take a code change', async () => {
    const siteId = (await createSite()).json().site.id;
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/sites/${siteId}`,
      headers: harness.as('admin'),
      payload: { code: 'ZZZ' },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('benches', () => {
  it('creates one and works its height out', async () => {
    const siteId = (await createSite()).json().site.id;
    const response = await createBench(siteId);
    expect(response.statusCode).toBe(201);
    expect(response.json().bench.heightM).toBe(15);
  });

  it('refuses a rock density nothing comes out of the ground at', async () => {
    const siteId = (await createSite()).json().site.id;
    const response = await createBench(siteId, { rockDensityKgM3: 500 });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a bench whose crest is under its toe', async () => {
    const siteId = (await createSite()).json().site.id;
    const response = await createBench(siteId, { crestLevelM: 60 });
    expect(response.statusCode).toBe(409);
  });

  it('lists the benches with their heights', async () => {
    const siteId = (await createSite()).json().site.id;
    await createBench(siteId);
    await createBench(siteId, { name: 'East 45', crestLevelM: 69, toeLevelM: 57 });
    const response = await harness.app.inject({
      method: 'GET',
      url: `/sites/${siteId}/benches`,
      headers: harness.as('viewer'),
    });
    expect(response.json().benches.map((bench) => bench.heightM)).toEqual([12, 15]);
  });

  it('filters the list by status', async () => {
    const siteId = (await createSite()).json().site.id;
    const benchId = (await createBench(siteId)).json().bench.id;
    await harness.app.inject({
      method: 'POST',
      url: `/benches/${benchId}/retire`,
      headers: harness.as('designer'),
    });
    const response = await harness.app.inject({
      method: 'GET',
      url: `/sites/${siteId}/benches?status=active`,
      headers: harness.as('viewer'),
    });
    expect(response.json().benches).toEqual([]);
  });

  it('refuses to retire the same bench twice', async () => {
    const siteId = (await createSite()).json().site.id;
    const benchId = (await createBench(siteId)).json().bench.id;
    await harness.app.inject({
      method: 'POST',
      url: `/benches/${benchId}/retire`,
      headers: harness.as('designer'),
    });
    const second = await harness.app.inject({
      method: 'POST',
      url: `/benches/${benchId}/retire`,
      headers: harness.as('designer'),
    });
    expect(second.statusCode).toBe(409);
  });

  it('updates a bench', async () => {
    const siteId = (await createSite()).json().site.id;
    const benchId = (await createBench(siteId)).json().bench.id;
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/benches/${benchId}`,
      headers: harness.as('designer'),
      payload: { rockType: 'limestone' },
    });
    expect(response.json().bench.rockType).toBe('limestone');
  });
});
