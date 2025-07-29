import { describe, it, expect } from 'vitest';
import {
  AREAS,
  NEVER_OVERRIDABLE,
  ADVISORY,
  severityOf,
  gather,
  decide,
  assertMayFire,
  validateOverride,
} from '../../../src/domain/firing/gate.js';
import { ValidationError, RuleViolationError } from '../../../src/lib/errors.js';

function clean() {
  return Object.fromEntries(AREAS.map((area) => [area, { valid: true, violations: [] }]));
}

describe('severity', () => {
  it('treats most findings as blocking', () => {
    expect(severityOf('stemming.minimum')).toBe('blocking');
  });

  it('treats the listed ones as advice', () => {
    expect(severityOf('batch.expiring')).toBe('advisory');
    expect(ADVISORY).toContain('reconcile.off_design');
  });

  it('holds a list of rules nothing overrides', () => {
    expect(NEVER_OVERRIDABLE).toContain('weather.lightning');
    expect(NEVER_OVERRIDABLE).toContain('clearance.stale');
  });
});

describe('gather', () => {
  it('labels every finding with where it came from', () => {
    const { findings } = gather({
      ...clean(),
      charging: { violations: [{ rule: 'stemming.minimum', message: 'short' }] },
    });
    expect(findings[0].area).toBe('charging');
    expect(findings[0].severity).toBe('blocking');
  });

  it('takes a bare array as well as a result object', () => {
    const { findings } = gather({ charging: [{ rule: 'charge.missing', message: 'empty' }] });
    expect(findings).toHaveLength(1);
  });

  it('records a check that was never run rather than passing it', () => {
    const { ran, notRun } = gather({ design: { violations: [] } });
    expect(ran).toEqual(['design']);
    expect(notRun).toContain('weather');
  });
});

describe('decide', () => {
  it('lets a clean shot fire', () => {
    const decision = decide(clean());
    expect(decision.mayFire).toBe(true);
    expect(decision.blocking).toEqual([]);
  });

  it('stops a shot with a blocking finding', () => {
    const decision = decide({
      ...clean(),
      clearance: { violations: [{ rule: 'clearance.stale', message: 'sweep is old' }] },
    });
    expect(decision.mayFire).toBe(false);
    expect(decision.byArea).toEqual({ clearance: 1 });
  });

  it('lets a shot fire with advice showing', () => {
    const decision = decide({
      ...clean(),
      explosives: { violations: [{ rule: 'batch.expiring', message: 'expires in three weeks' }] },
    });
    expect(decision.mayFire).toBe(true);
    expect(decision.advisory).toHaveLength(1);
  });

  it('stops a shot for a check that was never run', () => {
    const decision = decide({ design: { violations: [] } });
    expect(decision.mayFire).toBe(false);
    expect(decision.blocking.map((item) => item.rule)).toContain('gate.check_not_run');
  });

  it('only demands the checks the caller asked for', () => {
    const decision = decide({ design: { violations: [] } }, { requireAll: ['design'] });
    expect(decision.mayFire).toBe(true);
    expect(decision.checksNotRun).toContain('weather');
  });

  it('counts everything it looked at', () => {
    const decision = decide({
      ...clean(),
      charging: {
        violations: [
          { rule: 'stemming.minimum', message: 'a' },
          { rule: 'burden.excessive', message: 'b' },
        ],
      },
    });
    expect(decision.findingCount).toBe(2);
    expect(decision.blocking).toHaveLength(1);
    expect(decision.advisory).toHaveLength(1);
  });
});

describe('overrides', () => {
  const withFinding = {
    ...clean(),
    charging: { violations: [{ rule: 'stemming.minimum', message: 'short', holeNumber: 4 }] },
  };

  it('lets a named person override a finding', () => {
    const decision = decide(withFinding, {
      overrides: [
        { rule: 'stemming.minimum', by: 'per_9', reason: 'hole re stemmed on the bench' },
      ],
    });
    expect(decision.mayFire).toBe(true);
    expect(decision.overridden[0].overriddenBy).toBe('per_9');
  });

  it('applies an override only to the hole it names', () => {
    const decision = decide(withFinding, {
      overrides: [
        { rule: 'stemming.minimum', holeNumber: 7, by: 'per_9', reason: 'different hole' },
      ],
    });
    expect(decision.mayFire).toBe(false);
  });

  it('refuses to override an absolute rule', () => {
    const decision = decide(
      { ...clean(), weather: { violations: [{ rule: 'weather.lightning', message: 'storm' }] } },
      { overrides: [{ rule: 'weather.lightning', by: 'per_9', reason: 'we are in a hurry' }] },
    );
    expect(decision.mayFire).toBe(false);
    expect(decision.overridden).toEqual([]);
  });
});

describe('validateOverride', () => {
  it('takes a properly formed override', () => {
    const override = {
      rule: 'stemming.minimum',
      by: 'per_9',
      reason: 'hole re stemmed on the bench',
    };
    expect(validateOverride(override)).toBe(override);
  });

  it('refuses one with no reason or nobody behind it', () => {
    expect(() => validateOverride({ rule: 'stemming.minimum', by: 'per_9' })).toThrow(
      ValidationError,
    );
    expect(() =>
      validateOverride({ rule: 'stemming.minimum', reason: 'because I said so' }),
    ).toThrow(ValidationError);
  });

  it('refuses a reason that says nothing', () => {
    expect(() => validateOverride({ rule: 'stemming.minimum', by: 'per_9', reason: 'ok' })).toThrow(
      /real reason/,
    );
  });

  it('refuses an override of an absolute rule outright', () => {
    expect(() =>
      validateOverride({
        rule: 'clearance.stale',
        by: 'per_9',
        reason: 'the sweep was fine really',
      }),
    ).toThrow(/cannot be overridden/);
  });
});

describe('assertMayFire', () => {
  it('passes a clean decision through', () => {
    const decision = decide(clean());
    expect(assertMayFire(decision)).toBe(decision);
  });

  it('throws with every blocker attached', () => {
    const decision = decide({
      ...clean(),
      clearance: { violations: [{ rule: 'clearance.stale', message: 'sweep is old' }] },
    });
    try {
      assertMayFire(decision);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RuleViolationError);
      expect(error.violations[0].rule).toBe('clearance.stale');
    }
  });
});
