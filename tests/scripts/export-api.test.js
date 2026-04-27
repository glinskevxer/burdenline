import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { describeApi, render, differs } from '../../scripts/export-api.js';

describe('describeApi', () => {
  it('stands the server up and asks it what routes it has', async () => {
    const description = await describeApi();
    expect(description.service).toBe('burdenline');
    expect(description.routeCount).toBeGreaterThan(80);
  });

  it('lists a route from every module', async () => {
    const paths = (await describeApi()).routes.map((route) => `${route.method} ${route.path}`);
    for (const path of [
      'POST /sites',
      'POST /blasts/:blastId/fire',
      'GET /magazines/:magazineId/stock',
      'POST /sites/:siteId/orders',
      'GET /patterns/:patternId/rigs',
      'GET /sites/:siteId/regulator-pack',
    ]) {
      expect(paths).toContain(path);
    }
  });
});

describe('render', () => {
  it('writes stable json ending in a newline', () => {
    const written = render({
      service: 'burdenline',
      routeCount: 1,
      routes: [{ method: 'GET', path: '/health', body: null, query: null, hasSchema: false }],
    });
    expect(written.endsWith('\n')).toBe(true);
    expect(JSON.parse(written).routes[0].path).toBe('/health');
  });

  it('leaves out the fields that would churn the file', () => {
    const written = JSON.parse(
      render({
        service: 'burdenline',
        routeCount: 1,
        routes: [
          {
            method: 'GET',
            path: '/health',
            body: null,
            query: null,
            hasSchema: false,
            grant: null,
          },
        ],
      }),
    );
    expect(written.routes[0]).not.toHaveProperty('hasSchema');
    expect(written.routes[0]).not.toHaveProperty('grant');
  });

  it('spots a file that is out of date', () => {
    expect(differs('a', 'b')).toBe(true);
    expect(differs('a', 'a')).toBe(false);
    expect(differs(null, 'a')).toBe(true);
  });
});

describe('the file checked into the repository', () => {
  it('matches the routes the server registers', async () => {
    const written = render(await describeApi());
    expect(readFileSync('api.json', 'utf8')).toBe(written);
  });

  it('carries the body schema of a write route', () => {
    const description = JSON.parse(readFileSync('api.json', 'utf8'));
    const createSite = description.routes.find(
      (route) => route.method === 'POST' && route.path === '/sites',
    );
    expect(createSite.body.required).toEqual(['code', 'name']);
  });
});
