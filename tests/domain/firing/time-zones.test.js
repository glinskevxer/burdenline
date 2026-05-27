/**
 * The days the clocks change.
 *
 * A quarry in Ireland fires between one and four in the afternoon, local time,
 * and the day-book is kept on the local calendar day. Both of those are wrong by
 * an hour twice a year if anything reasons in UTC, and the failure mode is
 * quiet: a shot that reads as inside its permitted window when it was not, and a
 * day-book page with a movement on the wrong side of midnight.
 */

import { describe, it, expect } from 'vitest';
import {
  localDate,
  localTime,
  weekdayAt,
  withinLocalWindow,
  toInstant,
} from '../../../src/lib/clock.js';
import { parseSchedule, checkFiringTime } from '../../../src/domain/firing/firing-windows.js';
import { buildDay } from '../../../src/domain/magazine/daybook.js';

const zone = 'Europe/Dublin';
const schedule = parseSchedule({
  sunday: [{ from: '13:00', to: '16:00' }],
  monday: [{ from: '13:00', to: '16:00' }],
  tuesday: [{ from: '13:00', to: '16:00' }],
});

/** Summer time starts on the last Sunday in March and ends on the last in October. */
const SPRING_FORWARD = '2026-03-29';
const FALL_BACK = '2026-10-25';

describe('the clock at the site', () => {
  it('reads winter time as UTC and summer time an hour ahead', () => {
    expect(localTime('2026-01-15T12:00:00Z', zone)).toBe('12:00');
    expect(localTime('2026-07-15T12:00:00Z', zone)).toBe('13:00');
  });

  it('crosses the spring change without losing an hour', () => {
    expect(localTime(`${SPRING_FORWARD}T00:30:00Z`, zone)).toBe('00:30');
    expect(localTime(`${SPRING_FORWARD}T02:30:00Z`, zone)).toBe('03:30');
  });

  it('crosses the autumn change without gaining a day', () => {
    expect(localDate(`${FALL_BACK}T23:30:00Z`, zone)).toBe('2026-10-25');
    expect(localDate('2026-10-26T00:30:00Z', zone)).toBe('2026-10-26');
  });

  it('names the weekday in the site zone, not in UTC', () => {
    expect(weekdayAt('2026-03-29T22:30:00Z', zone)).toBe('sunday');
    expect(weekdayAt('2026-03-29T23:30:00Z', zone)).toBe('monday');
  });

  it('normalises an offset instant to the same moment', () => {
    expect(toInstant('2026-07-15T13:00:00+01:00')).toBe('2026-07-15T12:00:00.000Z');
  });
});

describe('the permitted window on the days the clocks change', () => {
  it('holds the window at local one to four on the spring change day', () => {
    const permitted = checkFiringTime({
      instant: `${SPRING_FORWARD}T13:00:00.000Z`,
      zone,
      schedule,
    });
    expect(permitted.localTime).toBe('14:00');
    expect(permitted.permitted).toBe(true);
  });

  it('refuses the same UTC moment that would be inside the window in winter', () => {
    const inWinter = withinLocalWindow('2026-01-11T15:30:00Z', zone, '13:00', '16:00');
    const inSummer = withinLocalWindow('2026-07-12T15:30:00Z', zone, '13:00', '16:00');
    expect(inWinter).toBe(true);
    expect(inSummer).toBe(false);
  });

  it('reads a shot an hour after the autumn change as inside the window', () => {
    const permitted = checkFiringTime({
      instant: `${FALL_BACK}T14:30:00.000Z`,
      zone,
      schedule,
    });
    expect(permitted.localTime).toBe('14:30');
    expect(permitted.permitted).toBe(true);
  });

  it('keeps a night window running past midnight through the change', () => {
    expect(withinLocalWindow(`${FALL_BACK}T23:30:00Z`, zone, '22:00', '06:00')).toBe(true);
    expect(withinLocalWindow('2026-10-26T04:00:00Z', zone, '22:00', '06:00')).toBe(true);
  });
});

describe('the day-book across a change', () => {
  function line(id, occurredAt) {
    return {
      id,
      magazineId: 'mag_1',
      movement: 'receipt',
      productCode: 'ANFO-80',
      quantity: 100,
      unit: 'kg',
      occurredAt,
      personName: 'M Cronin',
    };
  }

  it('keeps a late evening movement on the local day it happened', () => {
    const day = buildDay({
      siteId: 'site_1',
      date: '2026-07-15',
      zone,
      lines: [line('led_1', '2026-07-15T22:30:00.000Z')],
    });
    expect(day.lineCount).toBe(1);
  });

  it('puts a movement after local midnight on the next page', () => {
    const day = buildDay({
      siteId: 'site_1',
      date: '2026-07-15',
      zone,
      lines: [line('led_1', '2026-07-15T22:30:00.000Z'), line('led_2', '2026-07-15T23:30:00.000Z')],
    });
    expect(day.lineCount).toBe(1);
    expect(day.entries[0].ledgerId).toBe('led_1');
  });

  it('keeps the twenty five hour day on one page', () => {
    const lines = [
      line('led_1', `${FALL_BACK}T00:30:00.000Z`),
      line('led_2', `${FALL_BACK}T12:00:00.000Z`),
      line('led_3', `${FALL_BACK}T23:30:00.000Z`),
    ];
    const day = buildDay({ siteId: 'site_1', date: FALL_BACK, zone, lines });
    expect(day.lineCount).toBe(3);
    expect(day.closingBalances['ANFO-80']).toBe(300);
  });

  it('keeps the twenty three hour day on one page too', () => {
    const lines = [
      line('led_1', `${SPRING_FORWARD}T01:30:00.000Z`),
      line('led_2', `${SPRING_FORWARD}T22:30:00.000Z`),
    ];
    const day = buildDay({ siteId: 'site_1', date: SPRING_FORWARD, zone, lines });
    expect(day.lineCount).toBe(2);
  });

  it('reads the same lines differently in a zone on the other side of the world', () => {
    const lines = [line('led_1', '2026-07-15T23:30:00.000Z')];
    expect(
      buildDay({ siteId: 'site_1', date: '2026-07-16', zone: 'Pacific/Auckland', lines }).lineCount,
    ).toBe(1);
    expect(
      buildDay({ siteId: 'site_1', date: '2026-07-15', zone: 'Pacific/Auckland', lines }).lineCount,
    ).toBe(0);
  });
});
