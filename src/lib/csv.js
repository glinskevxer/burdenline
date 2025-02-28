/**
 * Comma separated files.
 *
 * Every instrument on a quarry exports one and no two agree on the details. The
 * profiler writes a byte order mark, the older seismographs write carriage
 * returns, the laboratory spreadsheet quotes any field with a comma in it and
 * doubles the quotes inside. This reads all of that and refuses the rest rather
 * than guessing, because a silently misparsed vibration record is a compliance
 * problem.
 */

import { ValidationError } from './errors.js';

const BOM = '﻿';

export function parseCsv(text, options = {}) {
  const delimiter = options.delimiter ?? ',';
  if (delimiter.length !== 1) {
    throw new ValidationError('a delimiter is one character', [
      { path: 'delimiter', message: 'must be a single character', kind: 'range' },
    ]);
  }
  if (typeof text !== 'string') {
    throw new ValidationError('csv input has to be text', [
      { path: 'text', message: 'expected a string', kind: 'type' },
    ]);
  }
  const source = text.startsWith(BOM) ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let sawField = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field === '') {
      quoted = true;
      sawField = true;
      continue;
    }
    if (character === delimiter) {
      row.push(field);
      field = '';
      sawField = false;
      continue;
    }
    if (character === '\r') {
      continue;
    }
    if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawField = false;
      continue;
    }
    field += character;
    sawField = true;
  }
  if (quoted) {
    throw new ValidationError('the file ends inside a quoted field', [
      { path: 'text', message: 'unbalanced quote', kind: 'malformed' },
    ]);
  }
  if (sawField || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Rows keyed by the header line. Headers are normalised so that `Peak (mm/s)`
 * and `peak_mm_s` land in the same field, which is the whole reason the vendor
 * parsers can share this.
 */
export function parseCsvRecords(text, options = {}) {
  const rows = parseCsv(text, options);
  const nonEmpty = rows.filter((candidate) => candidate.some((cell) => cell.trim() !== ''));
  if (nonEmpty.length === 0) {
    return { headers: [], records: [] };
  }
  const skip = options.skipLines ?? 0;
  const [headerRow, ...body] = nonEmpty.slice(skip);
  const headers = headerRow.map((cell) => normaliseHeader(cell));
  const seen = new Set();
  for (const header of headers) {
    if (header !== '' && seen.has(header)) {
      throw new ValidationError(`the column ${header} appears twice`, [
        { path: header, message: 'duplicate column', kind: 'malformed' },
      ]);
    }
    seen.add(header);
  }
  const records = body.map((cells, index) => {
    if (options.strictWidth && cells.length !== headers.length) {
      throw new ValidationError(
        `row ${index + 1} has ${cells.length} fields, expected ${headers.length}`,
        [{ path: `row.${index + 1}`, message: 'wrong number of fields', kind: 'malformed' }],
      );
    }
    const record = {};
    headers.forEach((header, position) => {
      if (header === '') {
        return;
      }
      record[header] = (cells[position] ?? '').trim();
    });
    return record;
  });
  return { headers, records };
}

export function normaliseHeader(cell) {
  return String(cell)
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function toCsv(records, options = {}) {
  const delimiter = options.delimiter ?? ',';
  const newline = options.newline ?? '\n';
  const columns = options.columns ?? inferColumns(records);
  const lines = [];
  if (options.header !== false) {
    lines.push(columns.map((column) => quoteField(String(column), delimiter)).join(delimiter));
  }
  for (const record of records) {
    lines.push(
      columns
        .map((column) => quoteField(formatCell(record[column], options), delimiter))
        .join(delimiter),
    );
  }
  return lines.join(newline) + (records.length || options.header !== false ? newline : '');
}

export function quoteField(value, delimiter = ',') {
  const text = value ?? '';
  if (text === '') {
    return '';
  }
  const needsQuotes =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text.trim() !== text;
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Read a numeric cell, treating the several spellings of nothing as nothing. */
export function readNumber(value, { field = 'value', allowBlank = true } = {}) {
  const text = String(value ?? '').trim();
  if (text === '' || text === '-' || text.toLowerCase() === 'n/a') {
    if (allowBlank) {
      return null;
    }
    throw new ValidationError(`${field} is missing`, [
      { path: field, message: 'a number is required', kind: 'missing' },
    ]);
  }
  const cleaned = text.replace(/,/g, '');
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`${field} is not a number`, [
      { path: field, message: `cannot read ${text} as a number`, kind: 'type' },
    ]);
  }
  return parsed;
}

function formatCell(value, options) {
  if (value === null || value === undefined) {
    return options.nullAs ?? '';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? String(value)
      : String(Number(value.toFixed(options.decimals ?? 6)));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function inferColumns(records) {
  const columns = [];
  const seen = new Set();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}
