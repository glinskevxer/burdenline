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

export const FORMATS = ['instantel', 'vibratech'];

const PSI_TO_PASCAL = 6894.757;

export function detectFormat(text) {
  const head = String(text).slice(0, 2000).toLowerCase();
  if (head.includes('serial number') || head.includes('minimate')) {
    return 'instantel';
  }
  if (head.includes('tran (in/s)') || head.includes('psi') || head.includes('vibratech')) {
    return 'vibratech';
  }
  throw new ValidationError('this file is not from a monitor the system knows', [
    { path: 'text', message: `expected one of ${FORMATS.join(', ')}`, kind: 'unsupported' },
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

export function parseInstantel(text, options = {}) {
  const preamble = readPreamble(text);
  const serial = options.monitorSerial ?? preamble.serial_number;
  if (!serial) {
    throw new ValidationError('the file does not say which monitor wrote it', [
      { path: 'serial_number', message: 'no serial number in the preamble', kind: 'missing' },
    ]);
  }
  const lines = parseCsv(text);
  const headerIndex = lines.findIndex((row) => normaliseHeader(row[0] ?? '') === 'date_time');
  if (headerIndex < 0) {
    throw new ValidationError('the file has no event table in it', [
      { path: 'text', message: 'no date and time column found', kind: 'malformed' },
    ]);
  }
  const body = text.split(/\r?\n/).slice(headerIndex).join('\n');
  const { records } = parseCsvRecords(body);
  return records
    .filter((row) => (row.date_time ?? '').trim() !== '')
    .map((row) =>
      parseRecord({
        monitorSerial: serial,
        receptorId: options.receptorId ?? null,
        triggeredAt: toInstant(row.date_time),
        distanceM: options.distanceM ?? null,
        longitudinal: {
          peakMmPerSecond: readNumber(row.long, { field: 'long', allowBlank: false }),
          frequencyHz: readNumber(row.long_freq),
        },
        transverse: {
          peakMmPerSecond: readNumber(row.tran, { field: 'tran', allowBlank: false }),
          frequencyHz: readNumber(row.tran_freq),
        },
        vertical: {
          peakMmPerSecond: readNumber(row.vert, { field: 'vert', allowBlank: false }),
          frequencyHz: readNumber(row.vert_freq),
        },
        airblastDb: readNumber(row.air),
        airblastFrequencyHz: readNumber(row.air_freq),
        triggerLevelMmPerSecond: readNumber(preamble.trigger_level ?? null),
      }),
    );
}

export function parseVibraTech(text, options = {}) {
  const { records } = parseCsvRecords(text);
  return records
    .filter((row) => (row.event ?? row.timestamp ?? '').trim() !== '')
    .map((row) => {
      const airblastPsi = readNumber(row.air);
      return parseRecord({
        monitorSerial: options.monitorSerial ?? row.unit ?? 'unknown',
        receptorId: options.receptorId ?? null,
        triggeredAt: toInstant(row.timestamp ?? row.event),
        distanceM: options.distanceM ?? readNumber(row.distance_ft),
        longitudinal: {
          peakMmPerSecond: toMm(readNumber(row.long, { field: 'long', allowBlank: false })),
          frequencyHz: readNumber(row.long_hz),
        },
        transverse: {
          peakMmPerSecond: toMm(readNumber(row.tran, { field: 'tran', allowBlank: false })),
          frequencyHz: readNumber(row.tran_hz),
        },
        vertical: {
          peakMmPerSecond: toMm(readNumber(row.vert, { field: 'vert', allowBlank: false })),
          frequencyHz: readNumber(row.vert_hz),
        },
        airblastDb:
          airblastPsi === null ? null : roundTo(pascalsToDecibels(airblastPsi * PSI_TO_PASCAL), 2),
        triggerLevelMmPerSecond:
          readNumber(row.trigger) === null ? null : toMm(readNumber(row.trigger)),
      });
    });
}

export function importRecords(text, options = {}) {
  const format = options.format ?? detectFormat(text);
  if (!FORMATS.includes(format)) {
    throw new ValidationError(`${format} is not a monitor format`, [
      { path: 'format', message: `expected one of ${FORMATS.join(', ')}`, kind: 'enum' },
    ]);
  }
  const records =
    format === 'instantel' ? parseInstantel(text, options) : parseVibraTech(text, options);
  return { format, records, count: records.length };
}

function toMm(inchesPerSecond) {
  return inchesPerSecond === null
    ? null
    : roundTo(inchesPerSecondToMmPerSecond(inchesPerSecond), 4);
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
