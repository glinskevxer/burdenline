import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  periodQuery,
  reasonBody,
  outcomeBody,
  designShape,
  tieInSchema,
} from '../../src/http/schemas.js';
import { standUp } from './helpers.js';

describe('the shared fragments', () => {
  it('are frozen, so a route cannot edit the one another route uses', () => {
    for (const fragment of [periodQuery, reasonBody, outcomeBody, designShape, tieInSchema]) {
      expect(Object.isFrozen(fragment)).toBe(true);
    }
  });

  it('make both ends of a period required', () => {
    expect(periodQuery.required).toEqual(['from', 'to']);
    expect(periodQuery.properties.from.minLength).toBe(4);
    expect(periodQuery.properties.to.minLength).toBe(4);
  });

  it('make a reason say something', () => {
    expect(reasonBody.required).toEqual(['reason']);
    expect(reasonBody.properties.reason.minLength).toBeGreaterThan(1);
    expect(reasonBody.additionalProperties).toBe(false);
  });

  it('describe a pattern completely enough to lay one out', () => {
    for (const field of ['burdenM', 'spacingM', 'benchHeightM', 'diameterMm', 'origin']) {
      expect(designShape.required).toContain(field);
    }
  });

  it('let a tie-in have no connectors, which a single hole shot has', () => {
    expect(tieInSchema.required).toEqual(['initiationHole', 'holes']);
  });
});

describe('the routes that use them', () => {
  let harness;
  let siteId;

  beforeEach(async () => {
    harness = await standUp({ at: '2026-07-28T09:00:00.000Z' });
    siteId = harness.expectOk(
      await harness.post('/sites', 'admin', { code: 'MDW', name: 'Midway' }),
      201,
    ).site.id;
  });

  afterEach(async () => {
    await harness.close();
  });

  it('refuse a period with nothing in it the same way on every report', async () => {
    for (const path of [
      `/sites/${siteId}/report?from=&to=`,
      `/sites/${siteId}/productivity?from=&to=`,
      `/sites/${siteId}/surveys?from=&to=`,
      `/sites/${siteId}/regulator-pack?from=&to=`,
    ]) {
      const response = await harness.get(path, 'manager');
      expect([path, response.statusCode]).toEqual([path, 422]);
    }
  });

  it('take a period the same way on every report', async () => {
    const period = 'from=2026-07-01T00:00:00.000Z&to=2026-07-31T00:00:00.000Z';
    for (const path of [
      `/sites/${siteId}/report?${period}`,
      `/sites/${siteId}/productivity?${period}`,
      `/sites/${siteId}/surveys?${period}`,
      `/sites/${siteId}/scorecard?${period}`,
    ]) {
      const response = await harness.get(path, 'manager');
      expect([path, response.statusCode]).toEqual([path, 200]);
    }
  });

  it('refuse a reason that says nothing the same way on every route that needs one', async () => {
    const blast = harness.expectOk(
      await harness.post(`/sites/${siteId}/blasts`, 'designer', { reference: 'MDW-2026-110' }),
      201,
    ).blast;
    for (const path of [`/blasts/${blast.id}/abandon`]) {
      const response = await harness.post(path, 'manager', { reason: 'no' });
      expect([path, response.statusCode]).toEqual([path, 422]);
    }
  });
});
