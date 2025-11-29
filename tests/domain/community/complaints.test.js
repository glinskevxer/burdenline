import { describe, it, expect } from 'vitest';
import {
  parseComplaint,
  advance,
  responseState,
  matchToBlasts,
  supportingRecords,
  summarise,
  CHANNELS,
  SUBJECTS,
  STATES,
  DEFAULT_RESPONSE_RULES,
} from '../../../src/domain/community/complaints.js';
import { ValidationError, StateError } from '../../../src/lib/errors.js';

function complaint(overrides = {}) {
  return parseComplaint({
    siteId: 'site_1',
    receptorId: 'rec_1',
    receivedAt: '2025-11-25T09:15:00.000Z',
    channel: 'telephone',
    complainant: 'Mrs Hurley',
    about: 'vibration',
    description: 'the pictures came off the wall again just after two yesterday',
    ...overrides,
  });
}

describe('parseComplaint', () => {
  it('takes one and starts it open', () => {
    expect(complaint().state).toBe('open');
    expect(Object.isFrozen(complaint())).toBe(true);
  });

  it('refuses a channel nobody uses', () => {
    expect(() => complaint({ channel: 'carrier_pigeon' })).toThrow(ValidationError);
  });

  it('refuses a description that says nothing', () => {
    expect(() => complaint({ description: 'bad' })).toThrow(ValidationError);
  });

  it('takes a complaint with no receptor against it', () => {
    expect(complaint({ receptorId: null }).receptorId).toBe(null);
  });

  it('names its vocabularies', () => {
    expect(CHANNELS).toContain('regulator');
    expect(SUBJECTS).toContain('flyrock');
    expect(STATES).toContain('withdrawn');
  });
});

describe('advance', () => {
  it('moves a complaint through investigation to a reply', () => {
    const investigating = advance(complaint(), 'investigate');
    expect(investigating.state).toBe('investigating');
    const responded = advance(investigating, 'respond', {
      outcome: 'readings were well under the limit',
    });
    expect(responded.state).toBe('responded');
    expect(responded.outcome).toContain('under the limit');
  });

  it('refuses a move that is not allowed from here', () => {
    expect(() => advance(complaint(), 'close')).toThrow(StateError);
  });

  it('refuses to respond with nothing written down', () => {
    expect(() => advance(complaint(), 'respond', {})).toThrow(/needs outcome/);
  });

  it('stamps a closing time', () => {
    const responded = advance(complaint(), 'respond', { outcome: 'answered by letter' });
    const closed = advance(responded, 'close', { at: '2025-11-30T09:00:00.000Z' });
    expect(closed.closedAt).toBe('2025-11-30T09:00:00.000Z');
  });

  it('lets a closed complaint be reopened', () => {
    const responded = advance(complaint(), 'respond', { outcome: 'answered by letter' });
    const closed = advance(responded, 'close', { at: '2025-11-30T09:00:00.000Z' });
    const reopened = advance(closed, 'reopen', { outcome: 'they rang again' });
    expect(reopened.state).toBe('investigating');
  });

  it('refuses an action nobody defined', () => {
    expect(() => advance(complaint(), 'ignore')).toThrow(ValidationError);
  });
});

describe('responseState', () => {
  it('counts the hours a complaint has been open', () => {
    const state = responseState(complaint(), '2025-11-26T09:15:00.000Z');
    expect(state.hoursOpen).toBe(24);
    expect(state.overdue).toBe(false);
  });

  it('goes overdue past the window in the permission', () => {
    const state = responseState(complaint(), '2025-12-02T09:15:00.000Z');
    expect(state.overdue).toBe(true);
    expect(state.hoursRemaining).toBeLessThan(0);
  });

  it('escalates when it has been sitting far too long', () => {
    expect(responseState(complaint(), '2025-12-10T09:15:00.000Z').escalate).toBe(true);
  });

  it('stops the clock once it has been answered', () => {
    const responded = advance(complaint(), 'respond', { outcome: 'answered' });
    expect(responseState(responded, '2025-12-31T09:15:00.000Z').overdue).toBe(false);
  });

  it('follows a tighter window from the site', () => {
    const state = responseState(complaint(), '2025-11-26T09:15:00.000Z', {
      ...DEFAULT_RESPONSE_RULES,
      respondWithinHours: 12,
    });
    expect(state.overdue).toBe(true);
  });
});

describe('matchToBlasts', () => {
  const blasts = [
    { id: 'blast_1', reference: 'MDW-2025-014', firedAt: '2025-11-24T14:02:00.000Z' },
    { id: 'blast_2', reference: 'MDW-2025-015', firedAt: '2025-11-25T13:58:00.000Z' },
  ];

  it('matches on the time the caller gave', () => {
    const match = matchToBlasts(complaint({ occurredAt: '2025-11-24T14:10:00.000Z' }), blasts);
    expect(match.matched).toBe(true);
    expect(match.best.blast.id).toBe('blast_1');
    expect(match.exact).toBe(true);
  });

  it('falls back to when the call came in', () => {
    const match = matchToBlasts(complaint(), blasts, { windowMinutes: 1440 });
    expect(match.matched).toBe(true);
    expect(match.exact).toBe(false);
  });

  it('finds nothing when no shot went off near the time', () => {
    const match = matchToBlasts(complaint({ occurredAt: '2025-11-20T10:00:00.000Z' }), blasts);
    expect(match.matched).toBe(false);
    expect(match.best).toBe(null);
  });

  it('offers every shot inside the window, nearest first', () => {
    const match = matchToBlasts(complaint({ occurredAt: '2025-11-25T13:00:00.000Z' }), blasts, {
      windowMinutes: 1500,
    });
    expect(match.candidates).toHaveLength(2);
    expect(match.candidates[0].blast.id).toBe('blast_2');
  });
});

describe('supportingRecords', () => {
  const records = [
    {
      id: 'mon_1',
      receptorId: 'rec_1',
      triggeredAt: '2025-11-24T14:02:10.000Z',
      peakMmPerSecond: 3.1,
    },
    {
      id: 'mon_2',
      receptorId: 'rec_2',
      triggeredAt: '2025-11-24T14:02:12.000Z',
      peakMmPerSecond: 1.4,
    },
    {
      id: 'mon_3',
      receptorId: 'rec_1',
      triggeredAt: '2025-11-20T09:00:00.000Z',
      peakMmPerSecond: 5.5,
    },
  ];

  it('takes the records around the time at that receptor', () => {
    const found = supportingRecords(complaint({ occurredAt: '2025-11-24T14:10:00.000Z' }), records);
    expect(found.map((record) => record.id)).toEqual(['mon_1']);
  });

  it('takes every receptor when the complaint names none', () => {
    const found = supportingRecords(
      complaint({ receptorId: null, occurredAt: '2025-11-24T14:10:00.000Z' }),
      records,
    );
    expect(found).toHaveLength(2);
  });

  it('comes back empty when nothing was recorded near the time', () => {
    expect(
      supportingRecords(complaint({ occurredAt: '2025-10-01T10:00:00.000Z' }), records),
    ).toEqual([]);
  });
});

describe('summarise', () => {
  const asOf = '2025-12-02T09:15:00.000Z';
  const complaints = [
    complaint(),
    complaint({ about: 'dust', receptorId: 'rec_2' }),
    advance(complaint({ receptorId: 'rec_1' }), 'respond', { outcome: 'answered' }),
    complaint({ receptorId: null, blastId: null }),
  ];

  it('counts by state, subject and receptor', () => {
    const summary = summarise(complaints, asOf);
    expect(summary.count).toBe(4);
    expect(summary.byState.open).toBe(3);
    expect(summary.bySubject.vibration).toBe(3);
    expect(summary.byReceptor.rec_1).toBe(2);
  });

  it('counts what is overdue', () => {
    expect(summarise(complaints, asOf).overdue).toBe(3);
  });

  it('names the receptors that have complained more than once', () => {
    expect(summarise(complaints, asOf).repeatReceptors).toEqual([
      { receptorId: 'rec_1', count: 2 },
    ]);
  });

  it('counts the ones nobody has tied to a shot', () => {
    expect(summarise(complaints, asOf).withoutBlast).toBe(4);
  });

  it('has nothing to say about a quiet period', () => {
    expect(summarise([], asOf)).toMatchObject({ count: 0, openCount: 0, overdue: 0 });
  });
});
