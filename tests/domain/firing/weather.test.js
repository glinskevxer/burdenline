import { describe, it, expect } from 'vitest';
import {
  parseObservation,
  inversionPresent,
  downwindStatus,
  checkConditions,
  reentryDelayMinutes,
  DEFAULT_WEATHER_RULES,
} from '../../../src/domain/firing/weather.js';
import { ValidationError } from '../../../src/lib/errors.js';

function observation(overrides = {}) {
  return parseObservation({
    observedAt: '2025-07-17T12:30:00.000Z',
    windSpeedMs: 4,
    windBearingDeg: 270,
    temperatureC: 16,
    temperatureAt10mC: 15.4,
    visibilityM: 8000,
    lightningDistanceKm: null,
    observedBy: 'M Cronin',
    ...overrides,
  });
}

const cottage = { id: 'rec_1', name: 'Keeper cottage', bearingDeg: 270, occupied: true };
const depot = { id: 'rec_2', name: 'Council depot', bearingDeg: 90, occupied: false };

describe('parseObservation', () => {
  it('takes a full observation', () => {
    expect(observation().windSpeedMs).toBe(4);
    expect(Object.isFrozen(observation())).toBe(true);
  });

  it('defaults rainfall to nothing and the upper temperature to unknown', () => {
    const plain = parseObservation({
      observedAt: '2025-07-17T12:30:00.000Z',
      windSpeedMs: 3,
      windBearingDeg: 10,
      temperatureC: 12,
    });
    expect(plain.rainfallMmPerHour).toBe(0);
    expect(plain.temperatureAt10mC).toBe(null);
  });

  it('refuses a bearing of a full circle', () => {
    expect(() => observation({ windBearingDeg: 360 })).toThrow(ValidationError);
  });

  it('refuses a wind speed nobody would be standing up in', () => {
    expect(() => observation({ windSpeedMs: 90 })).toThrow(ValidationError);
  });
});

describe('inversionPresent', () => {
  it('reads warmer air above as an inversion', () => {
    expect(inversionPresent(observation({ temperatureC: 12, temperatureAt10mC: 14 }))).toBe(true);
  });

  it('reads the ordinary profile as no inversion', () => {
    expect(inversionPresent(observation())).toBe(false);
  });

  it('has no answer without a second thermometer', () => {
    expect(inversionPresent(observation({ temperatureAt10mC: null }))).toBe(null);
  });
});

describe('downwindStatus', () => {
  it('calls a receptor on the wind axis downwind', () => {
    expect(downwindStatus(observation(), 270).downwind).toBe(true);
  });

  it('calls one at right angles crosswind', () => {
    const status = downwindStatus(observation(), 0);
    expect(status.crosswind).toBe(true);
    expect(status.downwind).toBe(false);
  });

  it('calls one behind the shot upwind', () => {
    expect(downwindStatus(observation(), 90).upwind).toBe(true);
  });

  it('measures how far off the axis it is', () => {
    expect(downwindStatus(observation(), 300).offAxisDeg).toBe(30);
  });
});

describe('checkConditions', () => {
  it('passes an ordinary summer afternoon', () => {
    const result = checkConditions({ observation: observation(), receptors: [cottage, depot] });
    expect(result.firable).toBe(true);
  });

  it('stops everything for lightning', () => {
    const result = checkConditions({ observation: observation({ lightningDistanceKm: 8 }) });
    expect(result.violations.map((v) => v.rule)).toContain('weather.lightning');
  });

  it('lets a distant storm go', () => {
    expect(checkConditions({ observation: observation({ lightningDistanceKm: 60 }) }).firable).toBe(
      true,
    );
  });

  it('stops a shot in a gale', () => {
    const result = checkConditions({ observation: observation({ windSpeedMs: 18 }) });
    expect(result.violations.map((v) => v.rule)).toContain('weather.wind_too_strong');
  });

  it('stops a shot under an inversion', () => {
    const result = checkConditions({
      observation: observation({ temperatureC: 8, temperatureAt10mC: 11 }),
    });
    expect(result.violations.map((v) => v.rule)).toContain('weather.inversion');
    expect(result.inversion).toBe(true);
  });

  it('lets a site that does not treat an inversion as blocking carry on', () => {
    const rules = { ...DEFAULT_WEATHER_RULES, inversionBlocks: false };
    const result = checkConditions({
      observation: observation({ temperatureC: 8, temperatureAt10mC: 11 }),
      rules,
    });
    expect(result.firable).toBe(true);
  });

  it('stops a shot blowing hard at an occupied house', () => {
    const result = checkConditions({
      observation: observation({ windSpeedMs: 9, windBearingDeg: 270 }),
      receptors: [cottage],
    });
    expect(result.violations.map((v) => v.rule)).toContain('weather.downwind_receptor');
  });

  it('does not stop it for an empty depot downwind', () => {
    const result = checkConditions({
      observation: observation({ windSpeedMs: 9, windBearingDeg: 90 }),
      receptors: [depot],
    });
    expect(result.firable).toBe(true);
  });

  it('stops a wet shot with no wind to clear the fume', () => {
    const result = checkConditions({
      observation: observation({ windSpeedMs: 1 }),
      receptors: [cottage],
      wetHoles: true,
    });
    expect(result.violations.map((v) => v.rule)).toContain('weather.fume_risk');
  });

  it('stops a shot in fog', () => {
    const result = checkConditions({ observation: observation({ visibilityM: 80 }) });
    expect(result.violations.map((v) => v.rule)).toContain('weather.visibility');
  });

  it('lists which receptors are downwind whether or not they stopped the shot', () => {
    const result = checkConditions({ observation: observation(), receptors: [cottage, depot] });
    expect(result.downwind.map((entry) => entry.receptorId)).toEqual(['rec_1']);
  });
});

describe('reentryDelayMinutes', () => {
  it('is short after a dry shot in a breeze', () => {
    expect(reentryDelayMinutes({ observation: observation() })).toBe(5);
  });

  it('grows for wet holes', () => {
    expect(reentryDelayMinutes({ observation: observation(), wetHoles: true })).toBe(15);
  });

  it('grows again with no wind to clear the fume', () => {
    expect(
      reentryDelayMinutes({ observation: observation({ windSpeedMs: 0.5 }), wetHoles: true }),
    ).toBe(30);
  });

  it('grows under an inversion and in the rain', () => {
    const delay = reentryDelayMinutes({
      observation: observation({ temperatureC: 8, temperatureAt10mC: 11, rainfallMmPerHour: 5 }),
    });
    expect(delay).toBe(20);
  });
});
