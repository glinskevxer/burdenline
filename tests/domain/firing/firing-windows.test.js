import { describe, it, expect } from 'vitest';
import {
  parseSchedule,
  permittedOn,
  withinPermittedWindow,
  embargoesOn,
  checkFiringTime,
  nextPermitted,
  WEEKDAYS,
  DEFAULT_NOTICE_RULES,
} from '../../../src/domain/firing/firing-windows.js';
import { ValidationError } from '../../../src/lib/errors.js';

const zone = 'Europe/Dublin';

const schedule = parseSchedule({
  monday: [{ from: '13:00', to: '16:00' }],
  tuesday: [{ from: '13:00', to: '16:00' }],
  wednesday: [{ from: '13:00', to: '16:00' }],
  thursday: [{ from: '13:00', to: '16:00' }],
  friday: [{ from: '13:00', to: '15:00' }],
});

/** A Tuesday in July, when Ireland is an hour ahead of UTC. */
const tuesdayTwoPm = '2025-07-29T13:00:00.000Z';

describe('parseSchedule', () => {
  it('keeps the windows it is given', () => {
    expect(schedule.monday).toEqual([{ from: '13:00', to: '16:00' }]);
  });

  it('leaves out the days with no window', () => {
    expect(schedule.saturday).toBe(undefined);
    expect(permittedOn(schedule, '2025-07-26T13:00:00.000Z', zone)).toEqual([]);
  });

  it('refuses a day that is not one', () => {
    expect(() => parseSchedule({ funday: [{ from: '13:00', to: '16:00' }] })).toThrow(
      ValidationError,
    );
  });

  it('refuses a window that ends before it starts', () => {
    expect(() => parseSchedule({ monday: [{ from: '16:00', to: '13:00' }] })).toThrow(
      /ends before/,
    );
  });

  it('refuses a time that is not one', () => {
    expect(() => parseSchedule({ monday: [{ from: '1pm', to: '16:00' }] })).toThrow(
      /not a wall clock time/,
    );
  });

  it('names the days of the week', () => {
    expect(WEEKDAYS).toHaveLength(7);
    expect(WEEKDAYS[0]).toBe('monday');
  });
});

describe('withinPermittedWindow', () => {
  it('allows a Tuesday afternoon', () => {
    expect(withinPermittedWindow(schedule, tuesdayTwoPm, zone)).toBe(true);
  });

  it('refuses a Tuesday morning', () => {
    expect(withinPermittedWindow(schedule, '2025-07-29T09:00:00.000Z', zone)).toBe(false);
  });

  it('refuses a Saturday', () => {
    expect(withinPermittedWindow(schedule, '2025-07-26T13:00:00.000Z', zone)).toBe(false);
  });

  it('reads the clock at the site, not in UTC', () => {
    expect(withinPermittedWindow(schedule, '2025-07-29T15:30:00.000Z', zone)).toBe(false);
    expect(withinPermittedWindow(schedule, '2025-07-29T14:30:00.000Z', zone)).toBe(true);
  });
});

describe('embargoesOn', () => {
  const embargoes = [
    { id: 'emb_1', date: '2025-07-29', reason: 'funeral at the church' },
    { id: 'emb_2', from: '2025-06-02', to: '2025-06-20', reason: 'state exams' },
    {
      id: 'emb_3',
      date: '2025-07-30',
      fromTime: '13:00',
      toTime: '14:00',
      reason: 'water works testing',
    },
  ];

  it('finds a whole day embargo', () => {
    expect(embargoesOn(embargoes, tuesdayTwoPm, zone).map((e) => e.id)).toEqual(['emb_1']);
  });

  it('finds a range embargo', () => {
    expect(embargoesOn(embargoes, '2025-06-10T13:00:00.000Z', zone).map((e) => e.id)).toEqual([
      'emb_2',
    ]);
  });

  it('applies a timed embargo only inside its hours', () => {
    expect(embargoesOn(embargoes, '2025-07-30T12:30:00.000Z', zone)).toHaveLength(1);
    expect(embargoesOn(embargoes, '2025-07-30T14:30:00.000Z', zone)).toHaveLength(0);
  });

  it('finds nothing on an ordinary day', () => {
    expect(embargoesOn(embargoes, '2025-08-05T13:00:00.000Z', zone)).toEqual([]);
  });
});

describe('checkFiringTime', () => {
  it('permits a Tuesday afternoon', () => {
    const result = checkFiringTime({ instant: tuesdayTwoPm, zone, schedule });
    expect(result.permitted).toBe(true);
    expect(result.localTime).toBe('14:00');
    expect(result.day).toBe('tuesday');
  });

  it('refuses a day with no window at all', () => {
    const result = checkFiringTime({ instant: '2025-07-26T13:00:00.000Z', zone, schedule });
    expect(result.violations.map((v) => v.rule)).toContain('firing.day_not_permitted');
  });

  it('refuses a time outside the window and says what the window was', () => {
    const result = checkFiringTime({ instant: '2025-07-29T09:00:00.000Z', zone, schedule });
    const violation = result.violations.find((v) => v.rule === 'firing.outside_window');
    expect(violation.message).toContain('13:00 to 16:00');
  });

  it('refuses an embargoed day even inside the window', () => {
    const result = checkFiringTime({
      instant: tuesdayTwoPm,
      zone,
      schedule,
      embargoes: [{ id: 'emb_1', date: '2025-07-29', reason: 'funeral at the church' }],
    });
    expect(result.permitted).toBe(false);
    expect(result.violations[0].message).toContain('funeral');
  });

  it('refuses a shot with too little notice', () => {
    const result = checkFiringTime({
      instant: tuesdayTwoPm,
      zone,
      schedule,
      notice: { givenAt: '2025-07-29T09:00:00.000Z' },
    });
    expect(result.violations.map((v) => v.rule)).toContain('firing.notice_short');
  });

  it('accepts notice given the day before', () => {
    const result = checkFiringTime({
      instant: tuesdayTwoPm,
      zone,
      schedule,
      notice: { givenAt: '2025-07-27T13:00:00.000Z' },
    });
    expect(result.permitted).toBe(true);
  });

  it('refuses notice given so long ago that nobody remembers it', () => {
    const result = checkFiringTime({
      instant: tuesdayTwoPm,
      zone,
      schedule,
      notice: { givenAt: '2025-06-01T13:00:00.000Z' },
    });
    expect(result.violations.map((v) => v.rule)).toContain('firing.notice_stale');
  });

  it('publishes the notice rules it works to', () => {
    expect(DEFAULT_NOTICE_RULES.minimumNoticeHours).toBe(24);
  });
});

describe('nextPermitted', () => {
  it('finds the next window from a morning', () => {
    const next = nextPermitted({ from: '2025-07-29T08:00:00.000Z', zone, schedule });
    expect(next).toBe('2025-07-29T12:00:00.000Z');
  });

  it('skips the weekend', () => {
    const next = nextPermitted({ from: '2025-07-26T08:00:00.000Z', zone, schedule });
    expect(next.slice(0, 10)).toBe('2025-07-28');
  });

  it('skips an embargoed day', () => {
    const next = nextPermitted({
      from: '2025-07-29T08:00:00.000Z',
      zone,
      schedule,
      embargoes: [{ id: 'emb_1', date: '2025-07-29', reason: 'funeral' }],
    });
    expect(next.slice(0, 10)).toBe('2025-07-30');
  });

  it('gives up rather than searching forever', () => {
    const closed = parseSchedule({});
    expect(
      nextPermitted({ from: '2025-07-29T08:00:00.000Z', zone, schedule: closed, limitDays: 2 }),
    ).toBe(null);
  });
});
