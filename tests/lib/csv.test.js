import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  parseCsvRecords,
  normaliseHeader,
  toCsv,
  quoteField,
  readNumber,
} from '../../src/lib/csv.js';
import { ValidationError } from '../../src/lib/errors.js';

describe('parseCsv', () => {
  it('splits a plain file', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('takes carriage returns from the older instruments', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips a byte order mark', () => {
    expect(parseCsv('﻿a,b\n1,2')[0]).toEqual(['a', 'b']);
  });

  it('keeps a comma inside a quoted field', () => {
    expect(parseCsv('a,b\n"Ballyhaunis, north",2')[1]).toEqual(['Ballyhaunis, north', '2']);
  });

  it('reads a doubled quote as one quote', () => {
    expect(parseCsv('a\n"he said ""toe"""')[1]).toEqual(['he said "toe"']);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('a,b\n"two\nlines",2')[1]).toEqual(['two\nlines', '2']);
  });

  it('keeps an empty trailing field', () => {
    expect(parseCsv('a,b,c\n1,,3')[1]).toEqual(['1', '', '3']);
  });

  it('does not invent a row after the final newline', () => {
    expect(parseCsv('a\n1\n')).toHaveLength(2);
  });

  it('refuses a file that ends inside a quote', () => {
    expect(() => parseCsv('a\n"unfinished')).toThrow(ValidationError);
  });

  it('refuses a delimiter that is not one character', () => {
    expect(() => parseCsv('a,b', { delimiter: '||' })).toThrow(ValidationError);
  });

  it('refuses anything that is not text', () => {
    expect(() => parseCsv(null)).toThrow(ValidationError);
  });

  it('takes a semicolon delimited export', () => {
    expect(parseCsv('a;b\n1;2', { delimiter: ';' })[1]).toEqual(['1', '2']);
  });
});

describe('normaliseHeader', () => {
  it('folds the vendor spellings together', () => {
    expect(normaliseHeader('Peak (mm/s)')).toBe('peak');
    expect(normaliseHeader('  Hole No. ')).toBe('hole_no');
    expect(normaliseHeader('Air-blast dB(L)')).toBe('air_blast_db');
  });
});

describe('parseCsvRecords', () => {
  it('keys the rows on the header', () => {
    const { records, headers } = parseCsvRecords('Hole No.,Depth (m)\n1,16.4\n2,16.1\n');
    expect(headers).toEqual(['hole_no', 'depth']);
    expect(records).toEqual([
      { hole_no: '1', depth: '16.4' },
      { hole_no: '2', depth: '16.1' },
    ]);
  });

  it('skips the preamble an instrument writes above the header', () => {
    const text = 'Instrument 4412\nSerial 88213\nhole,depth\n1,16\n';
    const { records } = parseCsvRecords(text, { skipLines: 2 });
    expect(records).toEqual([{ hole: '1', depth: '16' }]);
  });

  it('ignores blank lines in the body', () => {
    const { records } = parseCsvRecords('hole,depth\n1,16\n\n2,15\n');
    expect(records).toHaveLength(2);
  });

  it('trims the cells', () => {
    expect(parseCsvRecords('hole, depth\n1, 16.4 \n').records[0].depth).toBe('16.4');
  });

  it('drops a column with no name', () => {
    const { records } = parseCsvRecords('hole,,depth\n1,x,16\n');
    expect(records[0]).toEqual({ hole: '1', depth: '16' });
  });

  it('refuses a duplicated column', () => {
    expect(() => parseCsvRecords('hole,hole\n1,2\n')).toThrow(/appears twice/);
  });

  it('refuses a ragged row when asked to be strict', () => {
    expect(() => parseCsvRecords('a,b\n1\n', { strictWidth: true })).toThrow(ValidationError);
  });

  it('reads an empty file as nothing', () => {
    expect(parseCsvRecords('')).toEqual({ headers: [], records: [] });
  });
});

describe('toCsv', () => {
  it('writes a header from the keys', () => {
    expect(toCsv([{ hole: 1, depth: 16.4 }])).toBe('hole,depth\n1,16.4\n');
  });

  it('takes the column order it is given', () => {
    expect(toCsv([{ a: 1, b: 2 }], { columns: ['b', 'a'] })).toBe('b,a\n2,1\n');
  });

  it('can leave the header off', () => {
    expect(toCsv([{ a: 1 }], { header: false })).toBe('1\n');
  });

  it('quotes what has to be quoted', () => {
    expect(quoteField('north, upper')).toBe('"north, upper"');
    expect(quoteField('he said "no"')).toBe('"he said ""no"""');
    expect(quoteField(' padded ')).toBe('" padded "');
    expect(quoteField('plain')).toBe('plain');
    expect(quoteField('')).toBe('');
  });

  it('writes nothing for a missing value', () => {
    expect(toCsv([{ a: null, b: undefined, c: 1 }])).toBe('a,b,c\n,,1\n');
  });

  it('writes a chosen marker for a missing value', () => {
    expect(toCsv([{ a: null }], { nullAs: 'n/a' })).toBe('a\nn/a\n');
  });

  it('round trips through the parser', () => {
    const records = [{ site: 'Midway, north', peak: '4.2' }];
    expect(parseCsvRecords(toCsv(records)).records).toEqual(records);
  });

  it('takes the union of the keys across the rows', () => {
    expect(toCsv([{ a: 1 }, { b: 2 }])).toBe('a,b\n1,\n,2\n');
  });
});

describe('readNumber', () => {
  it('reads a plain number', () => {
    expect(readNumber('16.4')).toBe(16.4);
  });

  it('reads a thousands separator', () => {
    expect(readNumber('1,250')).toBe(1250);
  });

  it('reads the several spellings of nothing as nothing', () => {
    expect(readNumber('')).toBe(null);
    expect(readNumber('-')).toBe(null);
    expect(readNumber('N/A')).toBe(null);
    expect(readNumber(undefined)).toBe(null);
  });

  it('refuses a blank when the field is required', () => {
    expect(() => readNumber('', { field: 'peak', allowBlank: false })).toThrow(/peak is missing/);
  });

  it('refuses text that is not a number', () => {
    expect(() => readNumber('twelve', { field: 'depth' })).toThrow(ValidationError);
  });
});
