/**
 * Collecting rule violations.
 *
 * Every checker in the domain does the same three things: build a list of
 * violations, keep going after the first one, and hand back something that says
 * whether anything failed and groups what did. That pattern was written out four
 * separate times and had started to drift, so it lives here now. A violation is
 * a plain object with a stable `rule` key, because the reports group on it and a
 * renamed key is a silently empty section of a compliance report.
 */

export function violation(rule, message, extra = {}) {
  return { rule, message, ...extra };
}

export function collector() {
  const violations = [];
  return {
    add(rule, message, extra = {}) {
      violations.push(violation(rule, message, extra));
      return this;
    },
    addIf(condition, rule, message, extra = {}) {
      if (condition) {
        this.add(rule, message, extra);
      }
      return this;
    },
    /** Fails when the actual value is under the floor, and records both numbers. */
    atLeast(actual, required, rule, message, extra = {}) {
      return this.addIf(actual < required - 1e-9, rule, message, { ...extra, actual, required });
    },
    /** Fails when the actual value is over the ceiling. */
    atMost(actual, required, rule, message, extra = {}) {
      return this.addIf(actual > required + 1e-9, rule, message, { ...extra, actual, required });
    },
    absorb(more) {
      for (const item of more ?? []) {
        violations.push(item);
      }
      return this;
    },
    get length() {
      return violations.length;
    },
    all() {
      return violations;
    },
    result(extra = {}) {
      return { valid: violations.length === 0, violations, ...extra };
    },
  };
}

export function byRule(violations) {
  return violations.reduce((tally, item) => {
    tally[item.rule] = (tally[item.rule] ?? 0) + 1;
    return tally;
  }, {});
}

export function rulesBroken(violations) {
  return [...new Set(violations.map((item) => item.rule))].sort();
}

export function merge(...results) {
  const violations = results.flatMap((result) =>
    Array.isArray(result) ? result : (result?.violations ?? []),
  );
  return { valid: violations.length === 0, violations, byRule: byRule(violations) };
}
