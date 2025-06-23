/**
 * The explosives day-book.
 *
 * A bound book with a line for every movement, a running balance and a signature
 * against each one. It is the document an inspector asks for, and it is written
 * per day and per site with the lines numbered from one each morning. This
 * generates it from the ledger rather than being written into directly, so the
 * book and the ledger cannot drift, and it can be verified against the ledger at
 * any time.
 *
 * The running balance is per product, not per magazine, because that is how the
 * statutory columns are laid out.
 */

import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';
import { localDate } from '../../lib/clock.js';
import { toCsv } from '../../lib/csv.js';
import { collector } from '../violations.js';

export const DAYBOOK_COLUMNS = [
  'entry_date',
  'sequence',
  'time',
  'movement',
  'product',
  'batch',
  'quantity',
  'unit',
  'balance',
  'person',
  'reference',
];

/**
 * Turn a day of ledger lines into numbered entries. Opening balances carry over
 * from the previous close, and the lines are ordered by when the movement
 * happened rather than when it was typed in, which is how a late entry from the
 * bench ends up in the right place.
 */
export function buildDay({ siteId, date, lines, openingBalances = {}, zone = 'UTC' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new ValidationError(`${date} is not a day-book date`, [
      { path: 'date', message: 'expected a calendar date', kind: 'type' },
    ]);
  }
  const forDay = lines
    .filter((line) => localDate(line.occurredAt, zone) === date)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));

  const balances = { ...openingBalances };
  const entries = forDay.map((line, index) => {
    const product = line.productCode;
    const previous = balances[product] ?? 0;
    const balance = roundTo(previous + line.quantity, 4);
    balances[product] = balance;
    return {
      siteId,
      entryDate: date,
      sequence: index + 1,
      occurredAt: line.occurredAt,
      magazineId: line.magazineId,
      movement: line.movement,
      productCode: product,
      batchCode: line.batchCode ?? null,
      quantity: roundTo(line.quantity, 4),
      unit: line.unit,
      balanceAfter: balance,
      personName: line.personName ?? 'unrecorded',
      reference: line.reference ?? null,
      ledgerId: line.id,
    };
  });
  return { siteId, date, entries, closingBalances: balances, lineCount: entries.length };
}

/**
 * Check a written day against the ledger it should have come from. Three things
 * go wrong in practice: a line typed into the book that is not on the ledger, a
 * ledger line that never made it into the book, and a broken sequence where a
 * page was skipped.
 */
export function verifyDay(day, lines) {
  const found = collector();
  const ledgerIds = new Set(lines.map((line) => line.id));
  const entryIds = new Set(day.entries.map((entry) => entry.ledgerId));

  for (const entry of day.entries) {
    if (entry.ledgerId && !ledgerIds.has(entry.ledgerId)) {
      found.add('daybook.no_ledger_line', `entry ${entry.sequence} has no ledger line behind it`, {
        sequence: entry.sequence,
      });
    }
    if (!entry.personName || entry.personName === 'unrecorded') {
      found.add('daybook.unsigned', `entry ${entry.sequence} has nobody against it`, {
        sequence: entry.sequence,
      });
    }
  }
  for (const line of lines) {
    if (!entryIds.has(line.id)) {
      found.add('daybook.missing_entry', `ledger line ${line.id} was never written into the book`, {
        ledgerId: line.id,
      });
    }
  }
  const sequences = day.entries.map((entry) => entry.sequence).sort((a, b) => a - b);
  sequences.forEach((sequence, index) => {
    if (sequence !== index + 1) {
      found.add('daybook.sequence_broken', `the numbering jumps at ${sequence}`, { sequence });
    }
  });
  return found.result({ entryCount: day.entries.length, ledgerCount: lines.length });
}

/** The book as it is printed, one row per entry in the statutory column order. */
export function renderDay(day, { zone = 'UTC' } = {}) {
  const rows = day.entries.map((entry) => ({
    entry_date: entry.entryDate,
    sequence: entry.sequence,
    time: entry.occurredAt.slice(11, 16),
    movement: entry.movement,
    product: entry.productCode,
    batch: entry.batchCode,
    quantity: entry.quantity,
    unit: entry.unit,
    balance: entry.balanceAfter,
    person: entry.personName,
    reference: entry.reference,
  }));
  return toCsv(rows, { columns: DAYBOOK_COLUMNS, newline: '\n', nullAs: '', zone });
}

/** Run a stretch of days so the balances carry from one to the next. */
export function buildPeriod({ siteId, from, to, lines, openingBalances = {}, zone = 'UTC' }) {
  const days = [];
  let balances = { ...openingBalances };
  for (let date = from; date <= to; date = nextDate(date)) {
    const day = buildDay({ siteId, date, lines, openingBalances: balances, zone });
    balances = day.closingBalances;
    if (day.entries.length > 0) {
      days.push(day);
    }
  }
  return { siteId, from, to, days, closingBalances: balances, dayCount: days.length };
}

export function nextDate(date) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
