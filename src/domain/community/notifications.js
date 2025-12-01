/**
 * Telling the neighbours.
 *
 * The permission says who has to be told before a shot and how long before. Who
 * that is falls out of the receptor register: everybody occupied inside the
 * notification radius, plus anybody flagged notifiable however far out they are,
 * which is how the school two kilometres away ends up on the list.
 *
 * A notification that failed is not the same as one that was never planned, and
 * it is not the same as one that was not required. All three are recorded,
 * because the question after a complaint is always whether that house was told,
 * and "no record" is the answer nobody can defend.
 */

import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import { minutesBetween, isBefore } from '../../lib/clock.js';
import { withDistances } from '../receptors/registry.js';
import { collector } from '../violations.js';

export const CHANNELS = ['telephone', 'text_message', 'email', 'letter', 'sign', 'in_person'];
export const STATES = ['planned', 'sent', 'failed', 'not_required'];

export const DEFAULT_NOTICE_RULES = Object.freeze({
  radiusM: 500,
  minimumHoursBefore: 24,
  maximumHoursBefore: 168,
  channelsInOrder: ['text_message', 'telephone', 'email', 'letter'],
});

export const notificationSchema = z.object({
  blastId: z.string().min(1),
  receptorId: z.string().min(1).nullable().default(null),
  channel: z.enum(['telephone', 'text_message', 'email', 'letter', 'sign', 'in_person']),
  addressedTo: z.string().min(2).max(120),
  plannedFor: z.string().min(1),
  sentAt: z.string().nullable().default(null),
  state: z.enum(['planned', 'sent', 'failed', 'not_required']).default('planned'),
  failureReason: z.string().max(500).nullable().default(null),
});

export function parseNotification(input) {
  const parsed = notificationSchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the notification is not usable');
  }
  const notification = parsed.data;
  if (notification.state === 'failed' && !notification.failureReason) {
    throw new ValidationError('a failed notification says why it failed', [
      { path: 'failureReason', message: 'no reason given', kind: 'missing' },
    ]);
  }
  if (notification.state === 'sent' && !notification.sentAt) {
    throw new ValidationError('a sent notification carries when it went', [
      { path: 'sentAt', message: 'no time given', kind: 'missing' },
    ]);
  }
  return Object.freeze(notification);
}

/** Who has to be told about a shot, worked out from the receptor register. */
export function buildList({ blastId, receptors, holes, plannedFor, rules = DEFAULT_NOTICE_RULES }) {
  const inRange = withDistances(receptors, holes);
  const list = [];
  for (const entry of inRange) {
    const receptor = entry.receptor;
    const required = receptor.notifiable || (receptor.occupied && entry.distanceM <= rules.radiusM);
    if (!required) {
      continue;
    }
    list.push(
      parseNotification({
        blastId,
        receptorId: receptor.id,
        channel: channelFor(receptor, rules),
        addressedTo: receptor.name,
        plannedFor,
      }),
    );
  }
  return list;
}

export function channelFor(receptor, rules = DEFAULT_NOTICE_RULES) {
  if (receptor.preferredChannel && CHANNELS.includes(receptor.preferredChannel)) {
    return receptor.preferredChannel;
  }
  return rules.channelsInOrder[0];
}

export function markSent(notification, at) {
  if (notification.state === 'sent') {
    return notification;
  }
  return parseNotification({ ...notification, state: 'sent', sentAt: at, failureReason: null });
}

export function markFailed(notification, reason) {
  return parseNotification({
    ...notification,
    state: 'failed',
    failureReason: reason,
    sentAt: null,
  });
}

/**
 * Is the notice good at the moment the shot is due to go? Too little notice and
 * too much both fail, and a notification that was never sent fails whatever the
 * timing.
 */
export function checkNotice({ notifications, firingAt, rules = DEFAULT_NOTICE_RULES }) {
  const found = collector();
  for (const notification of notifications) {
    if (notification.state === 'not_required') {
      continue;
    }
    if (notification.state !== 'sent') {
      found.add('notice.not_sent', `${notification.addressedTo} has not been told`, {
        receptorId: notification.receptorId,
        state: notification.state,
      });
      continue;
    }
    if (!isBefore(notification.sentAt, firingAt)) {
      found.add('notice.after_the_shot', `${notification.addressedTo} was told after the shot`, {
        receptorId: notification.receptorId,
      });
      continue;
    }
    const hours = minutesBetween(notification.sentAt, firingAt) / 60;
    if (hours < rules.minimumHoursBefore) {
      found.add(
        'notice.too_short',
        `${notification.addressedTo} was given ${hours.toFixed(1)} hours of notice`,
        {
          receptorId: notification.receptorId,
          actual: Number(hours.toFixed(2)),
          required: rules.minimumHoursBefore,
        },
      );
    }
    if (hours > rules.maximumHoursBefore) {
      found.add(
        'notice.too_early',
        `${notification.addressedTo} was told ${(hours / 24).toFixed(1)} days ahead`,
        {
          receptorId: notification.receptorId,
          actual: Number(hours.toFixed(2)),
          required: rules.maximumHoursBefore,
        },
      );
    }
  }
  return found.result({
    total: notifications.length,
    sent: notifications.filter((notification) => notification.state === 'sent').length,
    failed: notifications.filter((notification) => notification.state === 'failed').length,
  });
}

export function summarise(notifications) {
  const byState = {};
  const byChannel = {};
  for (const notification of notifications) {
    byState[notification.state] = (byState[notification.state] ?? 0) + 1;
    byChannel[notification.channel] = (byChannel[notification.channel] ?? 0) + 1;
  }
  return {
    count: notifications.length,
    byState,
    byChannel,
    outstanding: notifications.filter((notification) => notification.state === 'planned').length,
  };
}
