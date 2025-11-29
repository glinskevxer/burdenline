/**
 * Complaints.
 *
 * Somebody rings up and says the house shook. That is a record with a clock on
 * it: the planning permission gives a working week to respond, and a complaint
 * that is answered late counts against the quarry whatever the monitors said.
 *
 * The useful part is the matching. A complaint at half past two on a Tuesday
 * either lines up with a shot or it does not, and if it does, there is usually a
 * monitor record to put beside it. A complaint that lines up with no shot at all
 * is worth knowing about too, because it is nearly always the crusher or a lorry
 * on the haul road, and answering it with vibration readings helps nobody.
 */

import { z } from 'zod';
import { ValidationError, StateError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';
import { minutesBetween } from '../../lib/clock.js';

export const CHANNELS = ['telephone', 'email', 'letter', 'in_person', 'regulator', 'other'];
export const SUBJECTS = ['vibration', 'airblast', 'dust', 'noise', 'flyrock', 'traffic', 'other'];
export const STATES = ['open', 'investigating', 'responded', 'closed', 'withdrawn'];

export const TRANSITIONS = Object.freeze({
  investigate: { from: ['open'], to: 'investigating' },
  respond: { from: ['open', 'investigating'], to: 'responded', requires: ['outcome'] },
  close: { from: ['responded', 'investigating'], to: 'closed' },
  withdraw: { from: ['open', 'investigating'], to: 'withdrawn', requires: ['outcome'] },
  reopen: { from: ['responded', 'closed'], to: 'investigating', requires: ['outcome'] },
});

export const DEFAULT_RESPONSE_RULES = Object.freeze({
  respondWithinHours: 120,
  escalateAfterHours: 240,
});

export const complaintSchema = z.object({
  siteId: z.string().min(1),
  receptorId: z.string().min(1).nullable().default(null),
  blastId: z.string().min(1).nullable().default(null),
  receivedAt: z.string().min(1),
  receivedBy: z.string().min(1).nullable().default(null),
  channel: z.enum(['telephone', 'email', 'letter', 'in_person', 'regulator', 'other']),
  complainant: z.string().max(120).nullable().default(null),
  contact: z.string().max(120).nullable().default(null),
  about: z.enum(['vibration', 'airblast', 'dust', 'noise', 'flyrock', 'traffic', 'other']),
  description: z.string().min(5).max(2000),
  occurredAt: z.string().nullable().default(null),
});

export function parseComplaint(input) {
  const parsed = complaintSchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the complaint is not usable');
  }
  return Object.freeze({ ...parsed.data, state: 'open', outcome: null });
}

export function advance(complaint, action, context = {}) {
  const transition = TRANSITIONS[action];
  if (!transition) {
    throw new ValidationError(`${action} is not something a complaint can do`, [
      {
        path: 'action',
        message: `expected one of ${Object.keys(TRANSITIONS).join(', ')}`,
        kind: 'enum',
      },
    ]);
  }
  if (!transition.from.includes(complaint.state)) {
    throw new StateError('complaint', complaint.state, action, transition.from);
  }
  for (const field of transition.requires ?? []) {
    if (!context[field]) {
      throw new ValidationError(`${action} needs ${field}`, [
        { path: field, message: 'required for this move', kind: 'missing' },
      ]);
    }
  }
  return {
    ...complaint,
    state: transition.to,
    outcome: context.outcome ?? complaint.outcome,
    closedAt:
      transition.to === 'closed' || transition.to === 'withdrawn' ? (context.at ?? null) : null,
  };
}

/** Where a complaint stands against the clock. */
export function responseState(complaint, asOf, rules = DEFAULT_RESPONSE_RULES) {
  if (['responded', 'closed', 'withdrawn'].includes(complaint.state)) {
    return { overdue: false, hoursOpen: null, state: complaint.state };
  }
  const hours = roundTo(minutesBetween(complaint.receivedAt, asOf) / 60, 2);
  return {
    hoursOpen: hours,
    overdue: hours > rules.respondWithinHours,
    escalate: hours > rules.escalateAfterHours,
    hoursRemaining: roundTo(rules.respondWithinHours - hours, 2),
    state: complaint.state,
  };
}

/**
 * Which shot, if any, the complaint is about. A complaint mentioning a time
 * matches on that; one that does not is matched on the day it was received,
 * which is what people actually do when they ring the next morning.
 */
export function matchToBlasts(complaint, blasts, { windowMinutes = 240 } = {}) {
  const target = complaint.occurredAt ?? complaint.receivedAt;
  const candidates = blasts
    .filter((blast) => blast.firedAt)
    .map((blast) => ({
      blast,
      minutesApart: roundTo(Math.abs(minutesBetween(blast.firedAt, target)), 1),
    }))
    .filter((candidate) => candidate.minutesApart <= windowMinutes)
    .sort((a, b) => a.minutesApart - b.minutesApart);
  return {
    matched: candidates.length > 0,
    best: candidates[0] ?? null,
    candidates,
    exact: Boolean(complaint.occurredAt),
  };
}

/** The monitor records that were taken around the same time, for the reply. */
export function supportingRecords(complaint, records, { windowMinutes = 240 } = {}) {
  const target = complaint.occurredAt ?? complaint.receivedAt;
  return records
    .filter((record) => Math.abs(minutesBetween(record.triggeredAt, target)) <= windowMinutes)
    .filter((record) => !complaint.receptorId || record.receptorId === complaint.receptorId)
    .sort(
      (a, b) =>
        Math.abs(minutesBetween(a.triggeredAt, target)) -
        Math.abs(minutesBetween(b.triggeredAt, target)),
    );
}

/** Patterns across a period, which is what a review meeting asks for. */
export function summarise(complaints, asOf, rules = DEFAULT_RESPONSE_RULES) {
  const byState = {};
  const bySubject = {};
  const byReceptor = {};
  for (const complaint of complaints) {
    byState[complaint.state] = (byState[complaint.state] ?? 0) + 1;
    bySubject[complaint.about] = (bySubject[complaint.about] ?? 0) + 1;
    if (complaint.receptorId) {
      byReceptor[complaint.receptorId] = (byReceptor[complaint.receptorId] ?? 0) + 1;
    }
  }
  const open = complaints.filter((complaint) =>
    ['open', 'investigating'].includes(complaint.state),
  );
  return {
    count: complaints.length,
    byState,
    bySubject,
    byReceptor,
    openCount: open.length,
    overdue: open.filter((complaint) => responseState(complaint, asOf, rules).overdue).length,
    repeatReceptors: Object.entries(byReceptor)
      .filter(([, count]) => count > 1)
      .map(([receptorId, count]) => ({ receptorId, count }))
      .sort((a, b) => b.count - a.count),
    withoutBlast: complaints.filter((complaint) => !complaint.blastId).length,
  };
}
