import { describe, it, expect } from 'vitest';
import {
  parseNotification,
  buildList,
  channelFor,
  markSent,
  markFailed,
  checkNotice,
  summarise,
  CHANNELS,
  STATES,
  DEFAULT_NOTICE_RULES,
} from '../../../src/domain/community/notifications.js';
import { parseReceptor } from '../../../src/domain/receptors/registry.js';
import { ValidationError } from '../../../src/lib/errors.js';

const plannedFor = '2025-12-02T13:00:00.000Z';

const holes = [{ holeNumber: 1, easting: 1000, northing: 2000, collarLevelM: 84 }];

const receptors = [
  parseReceptor({
    id: 'rec_1',
    name: 'Keeper cottage',
    structureClass: 'dwelling',
    easting: 1300,
    northing: 2000,
  }),
  parseReceptor({
    id: 'rec_2',
    name: 'Council depot',
    structureClass: 'commercial',
    easting: 1400,
    northing: 2000,
    occupied: false,
  }),
  parseReceptor({
    id: 'rec_3',
    name: 'Saint Brendan school',
    structureClass: 'commercial',
    easting: 3000,
    northing: 2000,
    notifiable: true,
  }),
];

function notification(overrides = {}) {
  return parseNotification({
    blastId: 'blast_1',
    receptorId: 'rec_1',
    channel: 'text_message',
    addressedTo: 'Keeper cottage',
    plannedFor,
    ...overrides,
  });
}

describe('parseNotification', () => {
  it('starts one planned', () => {
    expect(notification().state).toBe('planned');
  });

  it('refuses a channel nobody uses', () => {
    expect(() => notification({ channel: 'smoke_signal' })).toThrow(ValidationError);
  });

  it('refuses a failure with no reason', () => {
    expect(() => notification({ state: 'failed' })).toThrow(/says why it failed/);
  });

  it('refuses a sent notification with no time on it', () => {
    expect(() => notification({ state: 'sent' })).toThrow(/carries when it went/);
  });

  it('names its vocabularies', () => {
    expect(CHANNELS).toContain('sign');
    expect(STATES).toEqual(['planned', 'sent', 'failed', 'not_required']);
  });
});

describe('buildList', () => {
  it('takes the occupied neighbours inside the radius', () => {
    const list = buildList({ blastId: 'blast_1', receptors, holes, plannedFor });
    expect(list.map((entry) => entry.receptorId)).toContain('rec_1');
  });

  it('leaves an empty building out', () => {
    const list = buildList({ blastId: 'blast_1', receptors, holes, plannedFor });
    expect(list.map((entry) => entry.receptorId)).not.toContain('rec_2');
  });

  it('includes a flagged receptor however far out it is', () => {
    const list = buildList({ blastId: 'blast_1', receptors, holes, plannedFor });
    expect(list.map((entry) => entry.receptorId)).toContain('rec_3');
  });

  it('follows a wider radius when the permission says so', () => {
    const list = buildList({
      blastId: 'blast_1',
      receptors,
      holes,
      plannedFor,
      rules: { ...DEFAULT_NOTICE_RULES, radiusM: 2000 },
    });
    expect(list).toHaveLength(2);
  });

  it('uses the channel a receptor asked for', () => {
    const withPreference = [{ ...receptors[0], preferredChannel: 'telephone' }];
    const list = buildList({ blastId: 'blast_1', receptors: withPreference, holes, plannedFor });
    expect(list[0].channel).toBe('telephone');
  });

  it('falls back to the first channel in the order', () => {
    expect(channelFor({ name: 'x' })).toBe('text_message');
    expect(channelFor({ name: 'x', preferredChannel: 'pigeon' })).toBe('text_message');
  });
});

describe('marking them', () => {
  it('marks one sent with a time', () => {
    const sent = markSent(notification(), '2025-12-01T09:00:00.000Z');
    expect(sent.state).toBe('sent');
    expect(sent.sentAt).toBe('2025-12-01T09:00:00.000Z');
  });

  it('leaves one that is already sent alone', () => {
    const sent = markSent(notification(), '2025-12-01T09:00:00.000Z');
    expect(markSent(sent, '2025-12-01T10:00:00.000Z')).toBe(sent);
  });

  it('marks one failed with a reason and clears the sent time', () => {
    const failed = markFailed(notification(), 'the number was out of service');
    expect(failed.state).toBe('failed');
    expect(failed.sentAt).toBe(null);
  });

  it('refuses to mark one failed with nothing written down', () => {
    expect(() => markFailed(notification(), '')).toThrow(ValidationError);
  });
});

describe('checkNotice', () => {
  const firingAt = '2025-12-02T13:00:00.000Z';

  it('passes notice given the day before', () => {
    const notifications = [markSent(notification(), '2025-12-01T09:00:00.000Z')];
    expect(checkNotice({ notifications, firingAt }).valid).toBe(true);
  });

  it('catches a neighbour who was never told', () => {
    const result = checkNotice({ notifications: [notification()], firingAt });
    expect(result.violations[0].rule).toBe('notice.not_sent');
  });

  it('catches a failed attempt', () => {
    const failed = markFailed(notification(), 'the number was out of service');
    const result = checkNotice({ notifications: [failed], firingAt });
    expect(result.violations[0].rule).toBe('notice.not_sent');
    expect(result.failed).toBe(1);
  });

  it('catches notice given too late', () => {
    const notifications = [markSent(notification(), '2025-12-02T09:00:00.000Z')];
    const result = checkNotice({ notifications, firingAt });
    expect(result.violations[0].rule).toBe('notice.too_short');
  });

  it('catches notice given so long ago nobody remembers', () => {
    const notifications = [markSent(notification(), '2025-11-01T09:00:00.000Z')];
    expect(checkNotice({ notifications, firingAt }).violations[0].rule).toBe('notice.too_early');
  });

  it('catches somebody told after the shot went off', () => {
    const notifications = [markSent(notification(), '2025-12-02T14:00:00.000Z')];
    expect(checkNotice({ notifications, firingAt }).violations[0].rule).toBe(
      'notice.after_the_shot',
    );
  });

  it('skips the ones that were never required', () => {
    const notifications = [notification({ state: 'not_required' })];
    expect(checkNotice({ notifications, firingAt }).valid).toBe(true);
  });
});

describe('summarise', () => {
  it('counts by state and channel', () => {
    const notifications = [
      markSent(notification(), '2025-12-01T09:00:00.000Z'),
      notification({ receptorId: 'rec_3', addressedTo: 'school', channel: 'telephone' }),
    ];
    const summary = summarise(notifications);
    expect(summary.count).toBe(2);
    expect(summary.byState.sent).toBe(1);
    expect(summary.byChannel.telephone).toBe(1);
    expect(summary.outstanding).toBe(1);
  });
});
