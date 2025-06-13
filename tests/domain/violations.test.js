import { describe, it, expect } from 'vitest';
import { violation, collector, byRule, rulesBroken, merge } from '../../src/domain/violations.js';

describe('violation', () => {
  it('carries the rule key and whatever else the checker knows', () => {
    expect(violation('stemming.minimum', 'too short', { holeNumber: 4 })).toEqual({
      rule: 'stemming.minimum',
      message: 'too short',
      holeNumber: 4,
    });
  });
});

describe('collector', () => {
  it('starts empty and valid', () => {
    const found = collector();
    expect(found.length).toBe(0);
    expect(found.result()).toEqual({ valid: true, violations: [] });
  });

  it('collects rather than stopping at the first', () => {
    const found = collector().add('a', 'one').add('b', 'two');
    expect(found.length).toBe(2);
    expect(found.result().valid).toBe(false);
  });

  it('adds only when the condition holds', () => {
    const found = collector().addIf(false, 'a', 'one').addIf(true, 'b', 'two');
    expect(found.all().map((item) => item.rule)).toEqual(['b']);
  });

  it('records both numbers on a floor breach', () => {
    const found = collector().atLeast(1.5, 2.1, 'stemming.minimum', 'too short', { holeNumber: 3 });
    expect(found.all()[0]).toEqual({
      rule: 'stemming.minimum',
      message: 'too short',
      holeNumber: 3,
      actual: 1.5,
      required: 2.1,
    });
  });

  it('passes a value exactly on the floor or the ceiling', () => {
    expect(collector().atLeast(2.1, 2.1, 'r', 'm').length).toBe(0);
    expect(collector().atMost(2.1, 2.1, 'r', 'm').length).toBe(0);
  });

  it('does not fire on a floating point hair', () => {
    expect(collector().atLeast(0.1 + 0.2, 0.3, 'r', 'm').length).toBe(0);
  });

  it('catches a ceiling breach', () => {
    expect(collector().atMost(5, 4, 'r', 'm').all()[0].actual).toBe(5);
  });

  it('absorbs violations another checker found', () => {
    const found = collector()
      .add('a', 'one')
      .absorb([{ rule: 'b', message: 'two' }]);
    expect(found.length).toBe(2);
  });

  it('absorbs nothing without complaining', () => {
    expect(collector().absorb(undefined).length).toBe(0);
  });

  it('puts extra fields on the result', () => {
    expect(collector().result({ rules: { a: 1 } }).rules).toEqual({ a: 1 });
  });
});

describe('grouping', () => {
  const violations = [
    { rule: 'a', message: 'one' },
    { rule: 'a', message: 'two' },
    { rule: 'b', message: 'three' },
  ];

  it('counts by rule', () => {
    expect(byRule(violations)).toEqual({ a: 2, b: 1 });
  });

  it('lists the rules that were broken', () => {
    expect(rulesBroken(violations)).toEqual(['a', 'b']);
  });

  it('merges results from several checkers', () => {
    const merged = merge({ violations: [violations[0]] }, [violations[2]]);
    expect(merged.violations).toHaveLength(2);
    expect(merged.valid).toBe(false);
    expect(merged.byRule).toEqual({ a: 1, b: 1 });
  });

  it('merges an empty set into a pass', () => {
    expect(merge({ violations: [] }, [])).toMatchObject({ valid: true });
  });
});
