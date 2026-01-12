import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';
import { describeRoutes, summariseSchema } from '../../src/http/plugins/describe.js';

let harness;

beforeEach(async () => {
  harness = await standUp();
});

afterEach(async () => {
  await harness.close();
});

describe('summariseSchema', () => {
  it('lists the fields and says which are required', () => {
    const summary = summariseSchema({
      type: 'object',
      required: ['code'],
      additionalProperties: false,
      properties: { code: { type: 'string' }, name: { type: 'string' } },
    });
    expect(summary.required).toEqual(['code']);
    expect(summary.fields.map((field) => field.name)).toEqual(['code', 'name']);
    expect(summary.fields[0].required).toBe(true);
    expect(summary.allowsUnknown).toBe(false);
  });

  it('carries the values of an enumerated field', () => {
    const summary = summariseSchema({
      type: 'object',
      properties: { state: { type: 'string', enum: ['open', 'closed'] } },
    });
    expect(summary.fields[0].values).toEqual(['open', 'closed']);
  });

  it('has nothing to say about a route with no schema', () => {
    expect(summariseSchema(undefined)).toBe(null);
    expect(summariseSchema('nonsense')).toBe(null);
  });
});

describe('describeRoutes', () => {
  it('sorts by path and then by method', () => {
    const described = describeRoutes([
      { method: 'POST', url: '/sites' },
      { method: 'GET', url: '/sites' },
      { method: 'GET', url: '/blasts' },
    ]);
    expect(described.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /blasts',
      'GET /sites',
      'POST /sites',
    ]);
  });

  it('leaves itself out', () => {
    expect(describeRoutes([{ method: 'GET', url: '/describe' }])).toEqual([]);
  });
});

describe('GET /describe', () => {
  it('lists every route the server actually has', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/describe' });
    expect(response.statusCode).toBe(200);
    expect(response.json().routeCount).toBeGreaterThan(30);
  });

  it('includes the routes from every module', async () => {
    const paths = (await harness.app.inject({ method: 'GET', url: '/describe' }))
      .json()
      .routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain('POST /sites');
    expect(paths).toContain('POST /blasts/:blastId/fire');
    expect(paths).toContain('GET /magazines/:magazineId/stock');
    expect(paths).toContain('GET /sites/:siteId/regulator-pack');
  });

  it('shows what a route needs in its body', async () => {
    const routes = (await harness.app.inject({ method: 'GET', url: '/describe' })).json().routes;
    const createSite = routes.find((route) => route.method === 'POST' && route.path === '/sites');
    expect(createSite.body.required).toEqual(['code', 'name']);
    expect(createSite.body.allowsUnknown).toBe(false);
  });

  it('counts the writing routes that have no schema at all', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/describe' });
    expect(typeof response.json().withoutSchema).toBe('number');
  });

  it('needs no token, since it says nothing about any quarry', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/describe' });
    expect(response.statusCode).toBe(200);
  });
});
