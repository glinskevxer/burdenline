/**
 * The life of a shot.
 *
 * A blast moves through a fixed set of states and the order matters legally as
 * much as practically: nothing is loaded before the design is approved, nothing
 * is fired before the clearance is complete, and a shot that has fired is never
 * edited again. The state machine is written out rather than inferred from
 * timestamps, because the interesting question on the day is not when something
 * happened but what is allowed to happen next.
 *
 * A misfire is a state and not a flag. A shot that has misfired cannot be closed
 * and cannot have its exclusion zone lifted until somebody has made it safe, and
 * making that a state rather than a boolean is what stops the closing code from
 * having to remember.
 */

import { StateError, ValidationError } from '../../lib/errors.js';

export const STATES = [
  'draft',
  'designed',
  'submitted',
  'approved',
  'loaded',
  'tied_in',
  'cleared',
  'fired',
  'misfired',
  'made_safe',
  'inspected',
  'closed',
  'abandoned',
];

export const TRANSITIONS = Object.freeze({
  complete_design: { from: ['draft'], to: 'designed' },
  submit: { from: ['designed'], to: 'submitted' },
  approve: { from: ['submitted'], to: 'approved', requires: ['approverId'] },
  reject: { from: ['submitted'], to: 'designed', requires: ['reason'] },
  revise: { from: ['designed', 'approved'], to: 'draft' },
  load: { from: ['approved'], to: 'loaded', requires: ['shotfirerId'] },
  tie_in: { from: ['loaded'], to: 'tied_in' },
  clear: { from: ['tied_in'], to: 'cleared', requires: ['clearanceId'] },
  fire: { from: ['cleared'], to: 'fired', requires: ['shotfirerId', 'firedAt'] },
  report_misfire: { from: ['fired'], to: 'misfired', requires: ['reason'] },
  make_safe: { from: ['misfired'], to: 'made_safe', requires: ['shotfirerId'] },
  inspect: { from: ['fired', 'made_safe'], to: 'inspected', requires: ['inspectorId'] },
  close: { from: ['inspected'], to: 'closed' },
  abandon: {
    from: ['draft', 'designed', 'submitted', 'approved', 'loaded'],
    to: 'abandoned',
    requires: ['reason'],
  },
});

export const TERMINAL = ['closed', 'abandoned'];

export function actionsFrom(state) {
  return Object.entries(TRANSITIONS)
    .filter(([, transition]) => transition.from.includes(state))
    .map(([action]) => action)
    .sort();
}

export function can(state, action) {
  const transition = TRANSITIONS[action];
  return Boolean(transition && transition.from.includes(state));
}

export function isTerminal(state) {
  return TERMINAL.includes(state);
}

/** Once a shot is fired nothing about the design may be edited again. */
export function isEditable(state) {
  return ['draft', 'designed', 'submitted'].includes(state);
}

/**
 * Apply a transition. The context carries whatever the transition requires, and
 * a missing field is refused here rather than leaving a shot recorded as fired
 * by nobody.
 */
export function apply(blast, action, context = {}) {
  const transition = TRANSITIONS[action];
  if (!transition) {
    throw new ValidationError(`${action} is not something a blast can do`, [
      {
        path: 'action',
        message: `expected one of ${Object.keys(TRANSITIONS).join(', ')}`,
        kind: 'enum',
      },
    ]);
  }
  if (!transition.from.includes(blast.state)) {
    throw new StateError('blast', blast.state, action, transition.from);
  }
  const missing = (transition.requires ?? []).filter(
    (field) => context[field] === undefined || context[field] === null || context[field] === '',
  );
  if (missing.length > 0) {
    throw new ValidationError(
      `${action} needs ${missing.join(' and ')}`,
      missing.map((field) => ({
        path: field,
        message: 'required for this transition',
        kind: 'missing',
      })),
    );
  }
  const event = {
    action,
    from: blast.state,
    to: transition.to,
    at: context.at ?? null,
    by: context.actorId ?? context.shotfirerId ?? context.approverId ?? null,
    reason: context.reason ?? null,
  };
  return {
    blast: { ...blast, state: transition.to },
    event,
    history: [...(blast.history ?? []), event],
  };
}

/** Walk a whole sequence, which is how the fixtures and the tests build a shot. */
export function applyAll(blast, steps) {
  return steps.reduce((current, step) => {
    const { blast: next, history } = apply(current, step.action, step.context ?? {});
    return { ...next, history };
  }, blast);
}

export function newBlast(fields = {}) {
  return { state: 'draft', history: [], ...fields };
}

/** Where a shot got to, for the board on the wall. */
export function describeState(state) {
  const descriptions = {
    draft: 'being designed',
    designed: 'design finished, not submitted',
    submitted: 'waiting on approval',
    approved: 'approved, not loaded',
    loaded: 'charged',
    tied_in: 'tied in, not cleared',
    cleared: 'cleared to fire',
    fired: 'fired',
    misfired: 'misfired, not made safe',
    made_safe: 'made safe after a misfire',
    inspected: 'inspected',
    closed: 'closed',
    abandoned: 'abandoned',
  };
  const description = descriptions[state];
  if (!description) {
    throw new ValidationError(`${state} is not a blast state`, [
      { path: 'state', message: `expected one of ${STATES.join(', ')}`, kind: 'enum' },
    ]);
  }
  return description;
}
