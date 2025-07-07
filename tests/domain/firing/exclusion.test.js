import { describe, it, expect } from 'vitest';
import {
  throwDistanceM,
  confinementFactor,
  exclusionRadiusM,
  radiiFor,
  checkSentryCover,
  occupantsInside,
  DEFAULT_EXCLUSION_RULES,
} from '../../../src/domain/firing/exclusion.js';
import { ValidationError } from '../../../src/lib/errors.js';

describe('throwDistanceM', () => {
  it('grows with the hole diameter', () => {
    expect(throwDistanceM(165)).toBeGreaterThan(throwDistanceM(102));
  });

  it('reads a 102 millimetre hole at a few tens of metres', () => {
    expect(throwDistanceM(102)).toBeCloseTo(31.2, 1);
  });

  it('follows a coefficient the site set from its own worst throw', () => {
    const wilder = { ...DEFAULT_EXCLUSION_RULES, throwCoefficient: 300 };
    expect(throwDistanceM(102, wilder)).toBeGreaterThan(throwDistanceM(102));
  });

  it('refuses a diameter of zero', () => {
    expect(() => throwDistanceM(0)).toThrow(ValidationError);
  });
});

describe('confinementFactor', () => {
  it('is one for a properly stemmed shot', () => {
    expect(confinementFactor({})).toBe(1);
  });

  it('grows as the stemming is cut back', () => {
    expect(confinementFactor({ stemmingRatio: 0.5 })).toBe(1.75);
  });

  it('grows for cavities and a thin face burden', () => {
    expect(confinementFactor({ cavitiesPresent: true })).toBe(1.4);
    expect(confinementFactor({ faceBurdenThin: true })).toBe(1.6);
  });

  it('stacks the reasons', () => {
    expect(confinementFactor({ stemmingRatio: 0.5, cavitiesPresent: true })).toBe(2.15);
  });
});

describe('exclusionRadiusM', () => {
  it('holds the statutory minimum for an ordinary shot', () => {
    const zone = exclusionRadiusM({ diameterMm: 102 });
    expect(zone.radiusM).toBe(300);
    expect(zone.governedBy).toBe('statutory_minimum');
  });

  it('goes past the minimum once the shot is badly confined', () => {
    const zone = exclusionRadiusM({
      diameterMm: 165,
      confinement: { stemmingRatio: 0.3, cavitiesPresent: true, faceBurdenThin: true },
      rules: { ...DEFAULT_EXCLUSION_RULES, throwCoefficient: 400 },
    });
    expect(zone.governedBy).toBe('throw_estimate');
    expect(zone.radiusM).toBeGreaterThan(300);
  });

  it('rounds up to something a person can pace', () => {
    const zone = exclusionRadiusM({
      diameterMm: 165,
      rules: { ...DEFAULT_EXCLUSION_RULES, statutoryMinimumM: 317 },
    });
    expect(zone.radiusM).toBe(325);
  });
});

describe('radiiFor', () => {
  it('lets plant stand closer than people', () => {
    const radii = radiiFor(300);
    expect(radii.plantM).toBeLessThan(radii.personnelM);
  });

  it('holds a public road further back', () => {
    expect(radiiFor(300).publicRoadM).toBe(375);
  });
});

describe('checkSentryCover', () => {
  const approaches = [
    { id: 'app_1', name: 'haul road', easting: 1000, northing: 2400, sightLineM: 150 },
    { id: 'app_2', name: 'quarry gate', easting: 600, northing: 2000, sightLineM: 150 },
  ];
  const sentries = [
    {
      id: 'sen_1',
      name: 'J Ryan',
      covers: ['app_1'],
      easting: 1010,
      northing: 2380,
      hasRadio: true,
      distanceFromShotM: 400,
    },
    {
      id: 'sen_2',
      name: 'B Dunne',
      covers: ['app_2'],
      easting: 610,
      northing: 2010,
      hasRadio: true,
      distanceFromShotM: 420,
    },
  ];

  it('passes a zone with every approach covered', () => {
    expect(checkSentryCover({ approaches, sentries, radiusM: 300 }).valid).toBe(true);
  });

  it('catches an approach with nobody on it', () => {
    const result = checkSentryCover({ approaches, sentries: [sentries[0]], radiusM: 300 });
    expect(result.violations.map((v) => v.rule)).toContain('clearance.approach_uncovered');
  });

  it('catches a sentry too far from the approach to see it', () => {
    const distant = [{ ...sentries[0], easting: 1500, northing: 2900 }, sentries[1]];
    const result = checkSentryCover({ approaches, sentries: distant, radiusM: 300 });
    expect(result.violations.map((v) => v.rule)).toContain('clearance.sentry_too_far');
  });

  it('catches a sentry standing inside the zone', () => {
    const close = [{ ...sentries[0], distanceFromShotM: 200 }, sentries[1]];
    const result = checkSentryCover({ approaches, sentries: close, radiusM: 300 });
    expect(result.violations.map((v) => v.rule)).toContain('clearance.sentry_inside_zone');
  });

  it('catches a sentry with no radio', () => {
    const unreachable = [{ ...sentries[0], hasRadio: false }, sentries[1]];
    const result = checkSentryCover({ approaches, sentries: unreachable, radiusM: 300 });
    expect(result.violations.map((v) => v.rule)).toContain('clearance.sentry_no_radio');
  });

  it('reports how many sentries cover each approach', () => {
    const result = checkSentryCover({ approaches, sentries, radiusM: 300 });
    expect(result.covered).toEqual([
      { approachId: 'app_1', sentries: 1 },
      { approachId: 'app_2', sentries: 1 },
    ]);
  });

  it('refuses a zone with no approaches listed', () => {
    expect(() => checkSentryCover({ approaches: [], sentries, radiusM: 300 })).toThrow(
      ValidationError,
    );
  });
});

describe('occupantsInside', () => {
  const shotCentre = { easting: 1000, northing: 2000 };
  const radii = radiiFor(300);

  it('finds a person standing too close', () => {
    const inside = occupantsInside({
      occupants: [{ id: 'occ_1', kind: 'person', easting: 1100, northing: 2000 }],
      shotCentre,
      radii,
    });
    expect(inside).toHaveLength(1);
    expect(inside[0].distanceM).toBe(100);
    expect(inside[0].bearingDeg).toBe(90);
  });

  it('leaves plant alone at a distance that would fail for a person', () => {
    const occupants = [{ id: 'occ_2', kind: 'plant', easting: 1200, northing: 2000 }];
    expect(occupantsInside({ occupants, shotCentre, radii })).toHaveLength(0);
  });

  it('holds a public road further out than people', () => {
    const occupants = [{ id: 'occ_3', kind: 'public_road', easting: 1340, northing: 2000 }];
    expect(occupantsInside({ occupants, shotCentre, radii })).toHaveLength(1);
  });

  it('says nothing about a clear zone', () => {
    const occupants = [{ id: 'occ_4', kind: 'person', easting: 1500, northing: 2000 }];
    expect(occupantsInside({ occupants, shotCentre, radii })).toEqual([]);
  });
});
