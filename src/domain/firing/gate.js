/**
 * The gate.
 *
 * Everything that can stop a shot, asked in one place and answered as one list.
 * Nine separate checks feed it and they are all written elsewhere; what this
 * adds is that they are asked together, that each answer is labelled with where
 * it came from, and that the shot is refused unless every blocking one passes.
 *
 * Some findings hold the shot and some are advice. The split is not by which
 * check produced it: a stale clearance item is blocking and a certificate that
 * expires next week is not, and both come from checks that produce each kind.
 * So severity is decided by rule, and the rule list is the thing to read when
 * somebody asks why the shot went ahead with a warning showing.
 *
 * An override is possible because the alternative is people working around the
 * system, but it is recorded against a named person with a reason, it never
 * applies to a whole category, and there are rules nothing can override.
 */

import { ValidationError, RuleViolationError } from '../../lib/errors.js';
import { collector, byRule } from '../violations.js';

export const AREAS = [
  'design',
  'charging',
  'timing',
  'vibration',
  'explosives',
  'competency',
  'clearance',
  'weather',
  'schedule',
];

/** Rules nothing may override, whatever authority the person holds. */
export const NEVER_OVERRIDABLE = Object.freeze([
  'weather.lightning',
  'certificate.expired',
  'certificate.suspended',
  'certificate.missing',
  'person.not_a_shotfirer',
  'clearance.outstanding',
  'clearance.stale',
  'magazine.negative_stock',
  'timing.unreachable',
  'column.unprimed',
]);

/** Findings that are advice rather than a refusal. */
export const ADVISORY = Object.freeze([
  'batch.expiring',
  'reconcile.off_design',
  'timing.window_crowded',
  'stemming.maximum',
  'burden.excessive',
  'weather.downwind_receptor',
  'firing.notice_stale',
]);

export function severityOf(rule) {
  return ADVISORY.includes(rule) ? 'advisory' : 'blocking';
}

function tag(area, violations) {
  return (violations ?? []).map((item) => ({
    ...item,
    area,
    severity: severityOf(item.rule),
  }));
}

/**
 * Gather the findings. Every input is optional, because a shot at the design
 * stage has no clearance and one being reviewed has no weather yet, and a check
 * that has not been run is reported as not run rather than as passing.
 */
export function gather(inputs) {
  const findings = [];
  const ran = [];
  const notRun = [];
  const sources = {
    design: inputs.design,
    charging: inputs.charging,
    timing: inputs.timing,
    vibration: inputs.vibration,
    explosives: inputs.explosives,
    competency: inputs.competency,
    clearance: inputs.clearance,
    weather: inputs.weather,
    schedule: inputs.schedule,
  };
  for (const area of AREAS) {
    const source = sources[area];
    if (source === undefined || source === null) {
      notRun.push(area);
      continue;
    }
    ran.push(area);
    findings.push(...tag(area, Array.isArray(source) ? source : source.violations));
  }
  return { findings, ran, notRun };
}

/**
 * Decide. `requireAll` names the checks that must have been run at all, which is
 * how a shot is stopped for having no weather observation rather than for having
 * bad weather.
 */
export function decide(inputs, options = {}) {
  const requireAll = options.requireAll ?? AREAS;
  const overrides = options.overrides ?? [];
  const { findings, ran, notRun } = gather(inputs);

  const missing = requireAll.filter((area) => !ran.includes(area));
  const found = collector();
  for (const area of missing) {
    found.add('gate.check_not_run', `the ${area} check has not been run`, {
      area,
      severity: 'blocking',
    });
  }

  const applied = [];
  const remaining = [];
  for (const finding of findings) {
    const override = overrides.find(
      (candidate) => candidate.rule === finding.rule && matches(candidate, finding),
    );
    if (override && !NEVER_OVERRIDABLE.includes(finding.rule)) {
      applied.push({ ...finding, overriddenBy: override.by, reason: override.reason });
      continue;
    }
    remaining.push(finding);
  }

  const blocking = [
    ...remaining.filter((finding) => finding.severity === 'blocking'),
    ...found.all(),
  ];
  const advisory = remaining.filter((finding) => finding.severity === 'advisory');

  return {
    mayFire: blocking.length === 0,
    blocking,
    advisory,
    overridden: applied,
    checksRun: ran,
    checksNotRun: notRun,
    byArea: countBy(blocking, 'area'),
    byRule: byRule(blocking),
    findingCount: findings.length,
  };
}

/** Refuse loudly, for the call sites that want an exception rather than a report. */
export function assertMayFire(decision) {
  if (!decision.mayFire) {
    throw RuleViolationError.of(decision.blocking, 'the shot cannot be fired');
  }
  return decision;
}

export function validateOverride(override) {
  if (!override.rule || !override.by || !override.reason) {
    throw new ValidationError('an override names the rule, the person and the reason', [
      { path: 'override', message: 'rule, by and reason are all required', kind: 'missing' },
    ]);
  }
  if (NEVER_OVERRIDABLE.includes(override.rule)) {
    throw new ValidationError(`${override.rule} cannot be overridden by anybody`, [
      { path: 'rule', message: 'this rule is absolute', kind: 'forbidden' },
    ]);
  }
  if (override.reason.trim().length < 10) {
    throw new ValidationError('an override needs a real reason', [
      { path: 'reason', message: 'at least ten characters', kind: 'range' },
    ]);
  }
  return override;
}

function matches(override, finding) {
  if (override.holeNumber !== undefined && override.holeNumber !== finding.holeNumber) {
    return false;
  }
  if (override.receptorId !== undefined && override.receptorId !== finding.receptorId) {
    return false;
  }
  return true;
}

function countBy(items, key) {
  return items.reduce((tally, item) => {
    tally[item[key]] = (tally[item[key]] ?? 0) + 1;
    return tally;
  }, {});
}
