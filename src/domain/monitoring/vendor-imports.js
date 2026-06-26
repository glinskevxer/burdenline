/**
 * Reading what the monitors actually export.
 *
 * Two makes are in service and they do not agree on anything. The first writes a
 * preamble of instrument details above the header and reports in millimetres per
 * second. The second writes a flat file in inches per second with airblast in
 * pounds per square inch, and marks a channel that did not trigger with a dash
 * rather than leaving it blank. Neither writes the shot reference, so records
 * are matched to a shot by time afterwards.
 *
 * The format is detected rather than configured, because the person uploading
 * the file is a quarry manager with a memory stick and not an administrator.
 */

import { ValidationError } from '../../lib/errors.js';
import { parseCsv, parseCsvRecords, readNumber, normaliseHeader } from '../../lib/csv.js';
import { inchesPerSecondToMmPerSecond, poundsToKg, pascalsToDecibels } from '../../lib/units.js';
import { roundTo } from '../../lib/units.js';
import { parseRecord } from './records.js';

const FORMATS_LIST = ['instantel', 'vibratech', 'sigma'];
export { FORMATS_LIST as FORMATS };

const PSI_TO_PASCAL = 6894.757;

export function detectFormat(text) {
  const head = String(text).slice(0, 2000).toLowerCase();
  if (head.includes('serial number') || head.includes('minimate')) {
    return 'instantel';
  }
  if (head.includes('tran (in/s)') || head.includes('psi') || head.includes('vibratech')) {
    return 'vibratech';
  }
  if (head.includes('sigma') || head.includes('event time') || head.includes('ch1 (mm/s)')) {
    return 'sigma';
  }
  throw new ValidationError('this file is not from a monitor the system knows', [
    { path: 'text', message: `expected one of ${FORMATS_LIST.join(', ')}`, kind: 'unsupported' },
  ]);
}

/** Pull a labelled value out of the preamble, which is written as `Label: value`. */
export function readPreamble(text) {
  const preamble = {};
  for (const line of String(text).split(/\r?\n/).slice(0, 30)) {
    const match = /^([A-Za-z][A-Za-z ()/.]+?)\s*[:,]\s*(.+?)\s*$/.exec(line);
    if (match && !line.includes(',,')) {
      preamble[normaliseHeader(match[1])] = match[2].replace(/,+$/, '').trim();
    }
  }
  return preamble;
}

/**
 * The three readers differ in four things: where the header line is, what the
 * columns are called, whether the numbers are metric, and how a channel that did
 * not trigger is written. Everything else was copied between them, so it is one
 * function now with those four as a description.
 */
const FORMATS = {
  instantel: {
    label: 'Minimate style, metric, preamble above the header',
    findHeader: (rows) => rows.findIndex((row) => normaliseHeader(row[0] ?? '') === 'date_time'),
    serialFrom: (preamble) => preamble.serial_number,
    timeColumn: 'date_time',
    columns: {
      longitudinal: ['long', 'long_freq'],
      transverse: ['tran', 'tran_freq'],
      vertical: ['vert', 'vert_freq'],
      airblast: ['air', 'air_freq'],
    },
    toMmPerSecond: (value) => value,
    toDecibels: (value) => value,
    triggerFrom: (preamble) => readNumber(preamble.trigger_level ?? null),
  },
  vibratech: {
    label: 'imperial, flat file, a dash for a channel that did not trigger',
    findHeader: () => 0,
    serialFrom: (_preamble, row) => row.unit,
    timeColumn: 'timestamp',
    columns: {
      longitudinal: ['long', 'long_hz'],
      transverse: ['tran', 'tran_hz'],
      vertical: ['vert', 'vert_hz'],
      airblast: ['air', null],
    },
    toMmPerSecond: (value) =>
      value === null ? null : roundTo(inchesPerSecondToMmPerSecond(value), 4),
    toDecibels: (value) =>
      value === null ? null : roundTo(pascalsToDecibels(value * PSI_TO_PASCAL), 2),
    triggerFrom: (_preamble, row) => {
      const trigger = readNumber(row.trigger);
      return trigger === null ? null : roundTo(inchesPerSecondToMmPerSecond(trigger), 4);
    },
    distanceFrom: (row) => readNumber(row.distance_ft),
  },
  sigma: {
    label: 'Sigma style, metric, one row per channel folded into one event',
    findHeader: (rows) => rows.findIndex((row) => normaliseHeader(row[0] ?? '') === 'event_time'),
    serialFrom: (preamble) => preamble.instrument ?? preamble.unit_id,
    timeColumn: 'event_time',
    columns: {
      // The header normaliser strips the units in brackets, so `Ch1 (mm/s)`
      // arrives as `ch1` and `Ch1 Hz` as `ch1_hz`.
      longitudinal: ['ch1', 'ch1_hz'],
      transverse: ['ch2', 'ch2_hz'],
      vertical: ['ch3', 'ch3_hz'],
      airblast: ['ch4', 'ch4_hz'],
    },
    toMmPerSecond: (value) => value,
    toDecibels: (value) => value,
    triggerFrom: (preamble) => readNumber(preamble.trigger_mm_s ?? null),
  },
};

export function parseVendorFile(text, format, options = {}) {
  const shape = FORMATS[format];
  if (!shape) {
    throw new ValidationError(`${format} is not a monitor format`, [
      { path: 'format', message: `expected one of ${FORMATS_LIST.join(', ')}`, kind: 'enum' },
    ]);
  }
  const preamble = readPreamble(text);
  const lines = parseCsv(text);
  const headerIndex = shape.findHeader(lines);
  if (headerIndex < 0) {
    throw new ValidationError('the file has no event table in it', [
      { path: 'text', message: 'no time column found', kind: 'malformed' },
    ]);
  }
  const body = text.split(/\r?\n/).slice(headerIndex).join('\n');
  const { records } = parseCsvRecords(body);

  return records
    .filter((row) => (row[shape.timeColumn] ?? '').trim() !== '')
    .map((row) => {
      const serial = options.monitorSerial ?? shape.serialFrom(preamble, row);
      if (!serial) {
        throw new ValidationError('the file does not say which monitor wrote it', [
          { path: 'monitorSerial', message: 'no serial number', kind: 'missing' },
        ]);
      }
      const channel = (name, required) => {
        const [peakColumn, frequencyColumn] = shape.columns[name];
        const peak = readNumber(row[peakColumn], { field: peakColumn, allowBlank: !required });
        return {
          peakMmPerSecond: shape.toMmPerSecond(peak) ?? 0,
          frequencyHz: frequencyColumn ? readNumber(row[frequencyColumn]) : null,
        };
      };
      const [airColumn, airFrequency] = shape.columns.airblast;
      const air = readNumber(row[airColumn]);
      return parseRecord({
        monitorSerial: serial,
        receptorId: options.receptorId ?? null,
        triggeredAt: toInstant(row[shape.timeColumn]),
        distanceM: options.distanceM ?? (shape.distanceFrom ? shape.distanceFrom(row) : null),
        longitudinal: channel('longitudinal', true),
        transverse: channel('transverse', true),
        vertical: channel('vertical', true),
        airblastDb: shape.toDecibels(air),
        airblastFrequencyHz: airFrequency ? readNumber(row[airFrequency]) : null,
        triggerLevelMmPerSecond: shape.triggerFrom(preamble, row),
      });
    });
}

export function parseInstantel(text, options = {}) {
  return parseVendorFile(text, 'instantel', options);
}

export function parseVibraTech(text, options = {}) {
  return parseVendorFile(text, 'vibratech', options);
}

export function importRecords(text, options = {}) {
  const format = options.format ?? detectFormat(text);
  const records = parseVendorFile(text, format, options);
  return { format, records, count: records.length };
}

function toInstant(value) {
  const text = String(value ?? '').trim();
  const parsed = new Date(
    text.replace(' ', 'T').endsWith('Z') ? text.replace(' ', 'T') : `${text.replace(' ', 'T')}Z`,
  );
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${value} is not a time this system can read`, [
      { path: 'triggeredAt', message: 'unreadable timestamp', kind: 'type' },
    ]);
  }
  return parsed.toISOString();
}

export const conversions = { PSI_TO_PASCAL, poundsToKg };
