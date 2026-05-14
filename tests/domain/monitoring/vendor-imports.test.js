import { describe, it, expect } from 'vitest';
import {
  detectFormat,
  readPreamble,
  parseInstantel,
  parseVibraTech,
  importRecords,
  FORMATS,
} from '../../../src/domain/monitoring/vendor-imports.js';
import { ValidationError } from '../../../src/lib/errors.js';

const instantelFile = [
  'Minimate Plus Event Report',
  'Serial Number: BE-11482',
  'Trigger Level: 0.5',
  'Location: Keeper cottage',
  '',
  'Date Time,Tran,Tran Freq,Vert,Vert Freq,Long,Long Freq,Air,Air Freq',
  '2025-05-22 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0',
  '2025-05-29 14:11:02,1.20,22.0,0.90,31.0,1.05,19.0,104.1,9.0',
  '',
].join('\n');

const vibraTechFile = [
  'unit,timestamp,tran (in/s),tran hz,vert (in/s),vert hz,long (in/s),long hz,air (psi),trigger,distance ft',
  'VT-4412,2025-05-22 13:04:12,0.122,14.0,0.075,26.0,0.094,18.0,0.0029,0.02,1350',
  'VT-4412,2025-05-29 14:11:03,0.047,22.0,0.035,31.0,0.041,19.0,-,0.02,1350',
  '',
].join('\n');

const sigmaFile = [
  'Sigma Vibration Monitor',
  'Instrument: SG-2201',
  'Trigger mm/s: 0.4',
  '',
  'Event Time,Ch1 (mm/s),Ch1 Hz,Ch2 (mm/s),Ch2 Hz,Ch3 (mm/s),Ch3 Hz,Ch4 (dB),Ch4 Hz',
  '2026-05-18 13:04:11,2.40,18.0,3.10,14.0,1.90,26.0,110.2,11.0',
  '',
].join('\n');

describe('detectFormat', () => {
  it('knows the first make by its preamble', () => {
    expect(detectFormat(instantelFile)).toBe('instantel');
  });

  it('knows the second by its imperial columns', () => {
    expect(detectFormat(vibraTechFile)).toBe('vibratech');
  });

  it('refuses a file from neither', () => {
    expect(() => detectFormat('a,b\n1,2\n')).toThrow(ValidationError);
  });

  it('names every format it reads', () => {
    expect(FORMATS).toEqual(['instantel', 'vibratech', 'sigma']);
  });

  it('knows the third make by its channel columns', () => {
    expect(detectFormat(sigmaFile)).toBe('sigma');
  });
});

describe('readPreamble', () => {
  it('picks the labelled values out of the top of the file', () => {
    const preamble = readPreamble(instantelFile);
    expect(preamble.serial_number).toBe('BE-11482');
    expect(preamble.trigger_level).toBe('0.5');
  });
});

describe('parseInstantel', () => {
  it('reads every event row', () => {
    expect(parseInstantel(instantelFile)).toHaveLength(2);
  });

  it('takes the millimetre readings as they stand', () => {
    const [first] = parseInstantel(instantelFile);
    expect(first.transverse.peakMmPerSecond).toBe(3.1);
    expect(first.peakMmPerSecond).toBe(3.1);
    expect(first.peakComponent).toBe('transverse');
  });

  it('carries the serial number and the trigger level off the preamble', () => {
    const [first] = parseInstantel(instantelFile);
    expect(first.monitorSerial).toBe('BE-11482');
    expect(first.triggerLevelMmPerSecond).toBe(0.5);
  });

  it('reads the timestamp as an instant', () => {
    expect(parseInstantel(instantelFile)[0].triggeredAt).toBe('2025-05-22T13:04:11.000Z');
  });

  it('takes the receptor and distance from the caller, since the file has neither', () => {
    const [first] = parseInstantel(instantelFile, { receptorId: 'rec_1', distanceM: 412 });
    expect(first.receptorId).toBe('rec_1');
    expect(first.distanceM).toBe(412);
  });

  it('refuses a file with no serial number', () => {
    const anonymous = instantelFile.replace('Serial Number: BE-11482', 'Operator: J Ryan');
    expect(() => parseInstantel(anonymous)).toThrow(/which monitor wrote it/);
  });

  it('refuses a file with no event table', () => {
    expect(() => parseInstantel('Serial Number: BE-1\nnothing here\n')).toThrow(/no event table/);
  });
});

describe('parseVibraTech', () => {
  it('reads every event row', () => {
    expect(parseVibraTech(vibraTechFile)).toHaveLength(2);
  });

  it('converts inches per second to millimetres', () => {
    const [first] = parseVibraTech(vibraTechFile);
    expect(first.transverse.peakMmPerSecond).toBeCloseTo(3.099, 2);
  });

  it('converts the airblast from pounds per square inch to decibels', () => {
    const [first] = parseVibraTech(vibraTechFile);
    expect(first.airblastDb).toBeCloseTo(120, 0);
  });

  it('reads a dash as no airblast rather than as zero', () => {
    expect(parseVibraTech(vibraTechFile)[1].airblastDb).toBe(null);
  });

  it('converts the trigger level too', () => {
    expect(parseVibraTech(vibraTechFile)[0].triggerLevelMmPerSecond).toBeCloseTo(0.508, 3);
  });

  it('takes the unit name from the row', () => {
    expect(parseVibraTech(vibraTechFile)[0].monitorSerial).toBe('VT-4412');
  });
});

describe('importRecords', () => {
  it('detects the format and reads the file', () => {
    const result = importRecords(instantelFile, { receptorId: 'rec_1', distanceM: 412 });
    expect(result.format).toBe('instantel');
    expect(result.count).toBe(2);
  });

  it('takes a format the caller insists on', () => {
    const result = importRecords(vibraTechFile, { format: 'vibratech' });
    expect(result.format).toBe('vibratech');
  });

  it('refuses a format it has no reader for', () => {
    expect(() => importRecords(instantelFile, { format: 'seismodyne' })).toThrow(ValidationError);
  });

  it('reads the third make into the same shape as the other two', () => {
    const result = importRecords(sigmaFile, { receptorId: 'rec_1', distanceM: 300 });
    expect(result.format).toBe('sigma');
    expect(result.records[0].monitorSerial).toBe('SG-2201');
    expect(result.records[0].peakMmPerSecond).toBe(3.1);
    expect(result.records[0].peakComponent).toBe('transverse');
    expect(result.records[0].airblastDb).toBe(110.2);
    expect(result.records[0].triggerLevelMmPerSecond).toBe(0.4);
  });

  it('gives every make back in the same shape', () => {
    const shapes = [instantelFile, vibraTechFile, sigmaFile].map((file) =>
      Object.keys(importRecords(file).records[0]).sort(),
    );
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });
});
