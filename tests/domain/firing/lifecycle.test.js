import { describe, it, expect } from 'vitest';
import {
  STATES,
  TRANSITIONS,
  actionsFrom,
  can,
  isTerminal,
  isEditable,
  apply,
  applyAll,
  newBlast,
  describeState,
} from '../../../src/domain/firing/lifecycle.js';
import { StateError, ValidationError } from '../../../src/lib/errors.js';

const toApproved = [
  { action: 'complete_design' },
  { action: 'submit' },
  { action: 'approve', context: { approverId: 'per_9' } },
];

describe('the state set', () => {
  it('holds every state a shot can be in', () => {
    expect(STATES).toContain('misfired');
    expect(STATES).toContain('made_safe');
    expect(new Set(STATES).size).toBe(STATES.length);
  });

  it('sends every transition to a state that exists', () => {
    for (const transition of Object.values(TRANSITIONS)) {
      expect(STATES).toContain(transition.to);
      for (const from of transition.from) {
        expect(STATES).toContain(from);
      }
    }
  });
});

describe('what is allowed from where', () => {
  it('lists the moves out of a draft', () => {
    expect(actionsFrom('draft')).toEqual(['abandon', 'complete_design']);
  });

  it('lets a cleared shot only be fired', () => {
    expect(actionsFrom('cleared')).toEqual(['fire']);
  });

  it('lets nothing out of a closed shot', () => {
    expect(actionsFrom('closed')).toEqual([]);
    expect(isTerminal('closed')).toBe(true);
    expect(isTerminal('fired')).toBe(false);
  });

  it('answers a single question', () => {
    expect(can('approved', 'load')).toBe(true);
    expect(can('draft', 'fire')).toBe(false);
    expect(can('draft', 'teleport')).toBe(false);
  });

  it('stops the design being edited once it is approved', () => {
    expect(isEditable('draft')).toBe(true);
    expect(isEditable('submitted')).toBe(true);
    expect(isEditable('approved')).toBe(false);
    expect(isEditable('fired')).toBe(false);
  });
});

describe('apply', () => {
  it('moves the shot and records the event', () => {
    const { blast, event } = apply(newBlast(), 'complete_design');
    expect(blast.state).toBe('designed');
    expect(event).toMatchObject({ action: 'complete_design', from: 'draft', to: 'designed' });
  });

  it('refuses a move that is not allowed from here', () => {
    expect(() => apply(newBlast(), 'fire', { shotfirerId: 'per_1', firedAt: 'now' })).toThrow(
      StateError,
    );
  });

  it('names the states the move was allowed from', () => {
    try {
      apply(newBlast(), 'approve', { approverId: 'per_9' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.details.allowed).toEqual(['submitted']);
    }
  });

  it('refuses an approval with nobody approving', () => {
    const submitted = applyAll(newBlast(), toApproved.slice(0, 2));
    expect(() => apply(submitted, 'approve', {})).toThrow(/needs approverId/);
  });

  it('refuses a firing with no time on it', () => {
    const cleared = applyAll(newBlast(), [
      ...toApproved,
      { action: 'load', context: { shotfirerId: 'per_1' } },
      { action: 'tie_in' },
      { action: 'clear', context: { clearanceId: 'chk_1' } },
    ]);
    expect(() => apply(cleared, 'fire', { shotfirerId: 'per_1' })).toThrow(ValidationError);
  });

  it('refuses an action nobody has defined', () => {
    expect(() => apply(newBlast(), 'detonate')).toThrow(/not something a blast can do/);
  });

  it('keeps the history in order', () => {
    const approved = applyAll(newBlast(), toApproved);
    expect(approved.history.map((event) => event.action)).toEqual([
      'complete_design',
      'submit',
      'approve',
    ]);
  });

  it('records who did it and why', () => {
    const submitted = applyAll(newBlast(), toApproved.slice(0, 2));
    const { event } = apply(submitted, 'reject', {
      reason: 'burden on row one is too thin',
      actorId: 'per_9',
    });
    expect(event.reason).toContain('burden');
    expect(event.by).toBe('per_9');
  });
});

describe('the paths a shot actually takes', () => {
  const cleared = [
    ...toApproved,
    { action: 'load', context: { shotfirerId: 'per_1' } },
    { action: 'tie_in' },
    { action: 'clear', context: { clearanceId: 'chk_1' } },
  ];

  it('runs from draft to closed', () => {
    const closed = applyAll(newBlast(), [
      ...cleared,
      { action: 'fire', context: { shotfirerId: 'per_1', firedAt: '2025-06-29T13:00:00.000Z' } },
      { action: 'inspect', context: { inspectorId: 'per_2' } },
      { action: 'close' },
    ]);
    expect(closed.state).toBe('closed');
    expect(closed.history).toHaveLength(9);
  });

  it('sends a rejected design back to be worked on', () => {
    const rejected = applyAll(newBlast(), [
      { action: 'complete_design' },
      { action: 'submit' },
      { action: 'reject', context: { reason: 'stemming too short' } },
    ]);
    expect(rejected.state).toBe('designed');
    expect(can(rejected.state, 'submit')).toBe(true);
  });

  it('will not close a shot that misfired until it is made safe', () => {
    const misfired = applyAll(newBlast(), [
      ...cleared,
      { action: 'fire', context: { shotfirerId: 'per_1', firedAt: '2025-06-29T13:00:00.000Z' } },
      { action: 'report_misfire', context: { reason: 'row three did not go' } },
    ]);
    expect(() => apply(misfired, 'inspect', { inspectorId: 'per_2' })).toThrow(StateError);
    const safe = applyAll(misfired, [{ action: 'make_safe', context: { shotfirerId: 'per_1' } }]);
    expect(can(safe.state, 'inspect')).toBe(true);
  });

  it('lets a loaded shot be abandoned but not a fired one', () => {
    const loaded = applyAll(newBlast(), [
      ...toApproved,
      { action: 'load', context: { shotfirerId: 'per_1' } },
    ]);
    expect(can(loaded.state, 'abandon')).toBe(true);
    expect(can('fired', 'abandon')).toBe(false);
  });

  it('sends an approved shot back to draft when it is revised', () => {
    const approved = applyAll(newBlast(), toApproved);
    expect(applyAll(approved, [{ action: 'revise' }]).state).toBe('draft');
  });
});

describe('describeState', () => {
  it('says what every state means', () => {
    for (const state of STATES) {
      expect(typeof describeState(state)).toBe('string');
    }
  });

  it('refuses a state that is not one', () => {
    expect(() => describeState('exploded')).toThrow(ValidationError);
  });
});
