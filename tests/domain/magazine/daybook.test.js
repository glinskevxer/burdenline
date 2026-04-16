import { describe, it, expect } from 'vitest';
import {
  buildDay,
  verifyDay,
  renderDay,
  buildPeriod,
  nextDate,
  DAYBOOK_COLUMNS,
} from '../../../src/domain/magazine/daybook.js';
import { parseCsvRecords } from '../../../src/lib/csv.js';
import { ValidationError } from '../../../src/lib/errors.js';

function line(overrides = {}) {
  return {
    id: 'led_1',
    magazineId: 'mag_1',
    movement: 'receipt',
    productCode: 'ANFO-80',
    batchCode: 'L2025-114',
    quantity: 1000,
    unit: 'kg',
    occurredAt: '2025-06-20T09:14:00.000Z',
    personName: 'M Cronin',
    reference: 'DN-88213',
    ...overrides,
  };
}

const lines = [
  line(),
  line({ id: 'led_2', movement: 'issue', quantity: -400, occurredAt: '2025-06-20T11:02:00.000Z' }),
  line({
    id: 'led_3',
    movement: 'return',
    quantity: 25,
    occurredAt: '2025-06-20T16:40:00.000Z',
    personName: 'S Nolan',
  }),
];

describe('buildDay', () => {
  it('numbers the entries from one', () => {
    const day = buildDay({ siteId: 'site_1', date: '2025-06-20', lines });
    expect(day.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  });

  it('orders by when the movement happened, not when it was typed', () => {
    const shuffled = [lines[2], lines[0], lines[1]];
    const day = buildDay({ siteId: 'site_1', date: '2025-06-20', lines: shuffled });
    expect(day.entries.map((entry) => entry.ledgerId)).toEqual(['led_1', 'led_2', 'led_3']);
  });

  it('runs a balance down the page', () => {
    const day = buildDay({ siteId: 'site_1', date: '2025-06-20', lines });
    expect(day.entries.map((entry) => entry.balanceAfter)).toEqual([1000, 600, 625]);
  });

  it('carries an opening balance in', () => {
    const day = buildDay({
      siteId: 'site_1',
      date: '2025-06-20',
      lines,
      openingBalances: { 'ANFO-80': 500 },
    });
    expect(day.entries[0].balanceAfter).toBe(1500);
    expect(day.closingBalances['ANFO-80']).toBe(1125);
  });

  it('keeps a balance per product', () => {
    const mixed = [...lines, line({ id: 'led_4', productCode: 'EM-115', quantity: 300 })];
    const day = buildDay({ siteId: 'site_1', date: '2025-06-20', lines: mixed });
    expect(day.closingBalances).toEqual({ 'ANFO-80': 625, 'EM-115': 300 });
  });

  it('leaves other days alone', () => {
    const spread = [...lines, line({ id: 'led_5', occurredAt: '2025-06-21T09:00:00.000Z' })];
    expect(buildDay({ siteId: 'site_1', date: '2025-06-20', lines: spread }).lineCount).toBe(3);
  });

  it('reads the day in the site zone, not in UTC', () => {
    const lateLine = line({ id: 'led_6', occurredAt: '2025-06-20T23:30:00.000Z' });
    const day = buildDay({
      siteId: 'site_1',
      date: '2025-06-21',
      lines: [lateLine],
      zone: 'Pacific/Auckland',
    });
    expect(day.lineCount).toBe(1);
  });

  it('records a movement nobody signed as unrecorded rather than blank', () => {
    const unsigned = line({ id: 'led_7', personName: null });
    const day = buildDay({ siteId: 'site_1', date: '2025-06-20', lines: [unsigned] });
    expect(day.entries[0].personName).toBe('unrecorded');
  });

  it('refuses a date that is not one', () => {
    expect(() => buildDay({ siteId: 'site_1', date: 'today', lines })).toThrow(ValidationError);
  });
});

describe('consumption in the book', () => {
  it('is written into the book but does not move the balance', () => {
    const day = buildDay({
      siteId: 'site_1',
      date: '2025-06-20',
      lines: [
        line(),
        line({
          id: 'led_c',
          movement: 'issue',
          quantity: -400,
          occurredAt: '2025-06-20T10:00:00.000Z',
        }),
        line({
          id: 'led_d',
          movement: 'consumption',
          quantity: -380,
          occurredAt: '2025-06-20T17:00:00.000Z',
        }),
      ],
    });
    expect(day.entries.map((entry) => entry.balanceAfter)).toEqual([1000, 600, 600]);
    expect(day.entries).toHaveLength(3);
  });
});

describe('verifyDay', () => {
  const day = buildDay({ siteId: 'site_1', date: '2025-06-20', lines });

  it('passes a book built from its own ledger', () => {
    expect(verifyDay(day, lines).valid).toBe(true);
  });

  it('catches a ledger line that never reached the book', () => {
    const extra = [...lines, line({ id: 'led_9', occurredAt: '2025-06-20T18:00:00.000Z' })];
    const result = verifyDay(day, extra);
    expect(result.violations.map((v) => v.rule)).toContain('daybook.missing_entry');
  });

  it('catches an entry with no ledger line behind it', () => {
    const result = verifyDay(day, lines.slice(0, 2));
    expect(result.violations.map((v) => v.rule)).toContain('daybook.no_ledger_line');
  });

  it('catches an unsigned entry', () => {
    const unsigned = buildDay({
      siteId: 'site_1',
      date: '2025-06-20',
      lines: [line({ personName: null })],
    });
    const result = verifyDay(unsigned, [line({ personName: null })]);
    expect(result.violations.map((v) => v.rule)).toContain('daybook.unsigned');
  });

  it('catches a broken sequence', () => {
    const broken = {
      ...day,
      entries: day.entries.map((entry, index) => ({ ...entry, sequence: index + 2 })),
    };
    const result = verifyDay(broken, lines);
    expect(result.violations.map((v) => v.rule)).toContain('daybook.sequence_broken');
  });

  it('counts both sides so the totals can be compared by eye', () => {
    const result = verifyDay(day, lines);
    expect(result.entryCount).toBe(3);
    expect(result.ledgerCount).toBe(3);
  });
});

describe('renderDay', () => {
  const day = buildDay({ siteId: 'site_1', date: '2025-06-20', lines });

  it('writes the statutory columns in order', () => {
    expect(renderDay(day).split('\n')[0]).toBe(DAYBOOK_COLUMNS.join(','));
  });

  it('writes the time of each movement', () => {
    const { records } = parseCsvRecords(renderDay(day));
    expect(records[0].time).toBe('09:14');
  });

  it('writes the running balance', () => {
    const { records } = parseCsvRecords(renderDay(day));
    expect(records.map((record) => record.balance)).toEqual(['1000', '600', '625']);
  });

  it('leaves a missing batch code blank rather than writing null', () => {
    const noBatch = buildDay({
      siteId: 'site_1',
      date: '2025-06-20',
      lines: [line({ batchCode: null })],
    });
    expect(renderDay(noBatch)).not.toContain('null');
  });
});

describe('buildPeriod', () => {
  const spread = [
    line(),
    line({
      id: 'led_2',
      occurredAt: '2025-06-22T10:00:00.000Z',
      movement: 'issue',
      quantity: -300,
    }),
    line({
      id: 'led_3',
      occurredAt: '2025-06-24T10:00:00.000Z',
      movement: 'issue',
      quantity: -200,
    }),
  ];

  it('runs the days that have movements in them', () => {
    const period = buildPeriod({
      siteId: 'site_1',
      from: '2025-06-20',
      to: '2025-06-25',
      lines: spread,
    });
    expect(period.dayCount).toBe(3);
    expect(period.days.map((day) => day.date)).toEqual(['2025-06-20', '2025-06-22', '2025-06-24']);
  });

  it('carries the balance from one day to the next', () => {
    const period = buildPeriod({
      siteId: 'site_1',
      from: '2025-06-20',
      to: '2025-06-25',
      lines: spread,
    });
    expect(period.days[1].entries[0].balanceAfter).toBe(700);
    expect(period.closingBalances['ANFO-80']).toBe(500);
  });

  it('walks the calendar a day at a time', () => {
    expect(nextDate('2025-06-30')).toBe('2025-07-01');
    expect(nextDate('2025-12-31')).toBe('2026-01-01');
    expect(nextDate('2024-02-28')).toBe('2024-02-29');
  });
});
