import { describe, it, expect } from 'vitest';
import { buildPack, renderPack, SECTIONS } from '../../../src/domain/reporting/regulator-pack.js';
import { parseCsvRecords } from '../../../src/lib/csv.js';
import { ValidationError } from '../../../src/lib/errors.js';

const base = {
  siteName: 'Midway Quarry',
  licenceNumber: 'EL-4471',
  from: '2025-12-01',
  to: '2025-12-31',
  preparedBy: 'A Whelan',
  preparedAt: '2026-01-04T10:00:00.000Z',
};

const blast = {
  reference: 'MDW-2025-020',
  firedAt: '2025-12-11T13:00:00.000Z',
  holeCount: 24,
  totalChargeKg: 1000,
  instantaneousChargeKg: 86,
};

const record = {
  triggeredAt: '2025-12-11T13:00:04.000Z',
  receptorName: 'Keeper cottage',
  peakMmPerSecond: 4.97,
  peakFrequencyHz: 18,
  limitMmPerSecond: 19.1,
  airblastDb: 112.4,
};

describe('buildPack', () => {
  it('carries every section whether or not it has anything in it', () => {
    const pack = buildPack(base);
    for (const section of SECTIONS) {
      expect(pack[section]).toBeDefined();
    }
  });

  it('says so plainly when a section is empty', () => {
    const pack = buildPack(base);
    expect(pack.blasting.note).toContain('No blasting');
    expect(pack.complaints.note).toContain('No complaints');
    expect(pack.misfires.note).toContain('No misfires');
  });

  it('refuses a pack with no licence number on it', () => {
    expect(() => buildPack({ ...base, licenceNumber: null })).toThrow(ValidationError);
  });

  it('names the site, the licence and the period in the header', () => {
    const pack = buildPack(base);
    expect(pack.header).toMatchObject({
      siteName: 'Midway Quarry',
      licenceNumber: 'EL-4471',
      period: { from: '2025-12-01', to: '2025-12-31' },
    });
  });
});

describe('the blasting section', () => {
  it('adds the charges up and names the largest window', () => {
    const pack = buildPack({
      ...base,
      blasts: [blast, { ...blast, reference: 'MDW-2025-021', instantaneousChargeKg: 120 }],
    });
    expect(pack.blasting.count).toBe(2);
    expect(pack.blasting.totalChargeKg).toBe(2000);
    expect(pack.blasting.largestInstantaneousChargeKg).toBe(120);
  });
});

describe('the vibration and airblast sections', () => {
  it('reports the highest reading exactly as it was measured', () => {
    const pack = buildPack({ ...base, records: [record] });
    expect(pack.vibration.highest).toBe(4.97);
    expect(pack.vibration.highestReceptor).toBe('Keeper cottage');
  });

  it('averages the readings', () => {
    const pack = buildPack({ ...base, records: [record, { ...record, peakMmPerSecond: 2.03 }] });
    expect(pack.vibration.mean).toBe(3.5);
  });

  it('reports airblast separately', () => {
    const pack = buildPack({ ...base, records: [record] });
    expect(pack.airblast.highest).toBe(112.4);
  });

  it('says nothing was recorded when a channel is missing from every record', () => {
    const pack = buildPack({ ...base, records: [{ ...record, airblastDb: null }] });
    expect(pack.airblast.count).toBe(0);
    expect(pack.airblast.note).toContain('No airblast');
    expect(pack.vibration.count).toBe(1);
  });
});

describe('exceedances', () => {
  it('reports a clean period as compliant', () => {
    const pack = buildPack({ ...base, records: [record] });
    expect(pack.summary.compliant).toBe(true);
    expect(pack.declaration.compliant).toBe(true);
  });

  it('states an exceedance in the summary rather than burying it', () => {
    const pack = buildPack({
      ...base,
      records: [record],
      exceedances: [
        {
          triggeredAt: record.triggeredAt,
          receptorName: 'Keeper cottage',
          channels: ['ground'],
          ground: { peakMmPerSecond: 26, limitMmPerSecond: 19.1 },
        },
      ],
    });
    expect(pack.summary.compliant).toBe(false);
    expect(pack.summary.exceedanceCount).toBe(1);
    expect(pack.exceedances.rows[0].measured).toBe(26);
  });

  it('states an action against every exceedance', () => {
    const pack = buildPack({
      ...base,
      exceedances: [{ triggeredAt: record.triggeredAt, channels: ['airblast'] }],
    });
    expect(pack.exceedances.rows[0].action).toContain('reported');
  });
});

describe('the other sections', () => {
  it('lists complaints with what came of them', () => {
    const pack = buildPack({
      ...base,
      complaints: [
        {
          receivedAt: '2025-12-12T09:00:00.000Z',
          about: 'vibration',
          state: 'closed',
          outcome: 'answered by letter',
        },
      ],
    });
    expect(pack.complaints.rows[0].outcome).toBe('answered by letter');
  });

  it('says a complaint still open is under investigation', () => {
    const pack = buildPack({
      ...base,
      complaints: [{ receivedAt: '2025-12-12T09:00:00.000Z', about: 'dust', state: 'open' }],
    });
    expect(pack.complaints.rows[0].outcome).toBe('under investigation');
  });

  it('lists misfires with the holes named', () => {
    const pack = buildPack({
      ...base,
      misfires: [
        {
          discoveredAt: '2025-12-11T14:00:00.000Z',
          blastId: 'blast_1',
          kind: 'unfired_hole',
          holeNumbers: [14, 15],
        },
      ],
    });
    expect(pack.misfires.rows[0].holes).toBe('14, 15');
  });

  it('adds the explosive consumed up', () => {
    const pack = buildPack({
      ...base,
      explosives: [
        { productCode: 'ANFO-80', quantity: 1000 },
        { productCode: 'EM-115', quantity: 300 },
      ],
    });
    expect(pack.explosives.totalKg).toBe(1300);
  });
});

describe('renderPack', () => {
  it('writes the files that get attached', () => {
    const pack = buildPack({ ...base, blasts: [blast], records: [record] });
    const files = renderPack(pack);
    expect(Object.keys(files)).toContain('blasts.csv');
    expect(parseCsvRecords(files['vibration.csv']).records[0].peakmmpersecond).toBe('4.97');
  });

  it('writes the summary as json with the header on it', () => {
    const files = renderPack(buildPack(base));
    expect(JSON.parse(files['summary.json']).header.siteName).toBe('Midway Quarry');
  });

  it('writes an empty file rather than leaving one out', () => {
    const files = renderPack(buildPack(base));
    expect(files['complaints.csv']).toBe('\n');
    expect(parseCsvRecords(files['complaints.csv']).records).toEqual([]);
  });
});
