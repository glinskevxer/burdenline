/**
 * The pack that goes to the regulator.
 *
 * It has a fixed shape because the person reading it reads twenty of them from
 * twenty quarries and will not go looking for anything. Every section is present
 * whether or not it has content, and a section with nothing in it says so rather
 * than being left out, because an absent section reads as an oversight.
 *
 * Nothing is rounded away. If a reading was 4.97 it goes in as 4.97, not as
 * "under 5", and an exceedance is stated in the first paragraph rather than
 * being left for the appendix.
 */

import { roundTo } from '../../lib/units.js';
import { ValidationError } from '../../lib/errors.js';
import { toCsv } from '../../lib/csv.js';

export const SECTIONS = [
  'header',
  'blasting',
  'vibration',
  'airblast',
  'exceedances',
  'complaints',
  'misfires',
  'explosives',
  'declaration',
];

export function buildPack(input) {
  for (const field of ['siteName', 'licenceNumber', 'from', 'to', 'preparedBy']) {
    if (!input[field]) {
      throw new ValidationError(`a regulator pack needs ${field}`, [
        { path: field, message: 'required', kind: 'missing' },
      ]);
    }
  }
  const period = { from: input.from, to: input.to };
  const blasting = blastingSection(input);
  const vibration = vibrationSection(input);
  const airblast = airblastSection(input);
  const exceedances = exceedanceSection(input);

  return {
    header: {
      siteName: input.siteName,
      licenceNumber: input.licenceNumber,
      period,
      preparedBy: input.preparedBy,
      preparedAt: input.preparedAt ?? null,
    },
    blasting,
    vibration,
    airblast,
    exceedances,
    complaints: complaintSection(input),
    misfires: misfireSection(input),
    explosives: explosivesSection(input),
    declaration: {
      statement:
        'The information in this return is a true record taken from the site blasting records for the period stated.',
      signedBy: input.preparedBy,
      compliant: exceedances.count === 0,
    },
    summary: {
      compliant: exceedances.count === 0,
      blastCount: blasting.count,
      highestPeakMmPerSecond: vibration.highest,
      exceedanceCount: exceedances.count,
      complaintCount: input.complaints?.length ?? 0,
    },
  };
}

function blastingSection({ blasts = [] }) {
  if (blasts.length === 0) {
    return { count: 0, note: 'No blasting was carried out in the period.', rows: [] };
  }
  return {
    count: blasts.length,
    totalChargeKg: roundTo(
      blasts.reduce((sum, blast) => sum + (blast.totalChargeKg ?? 0), 0),
      2,
    ),
    largestInstantaneousChargeKg: roundTo(
      Math.max(...blasts.map((blast) => blast.instantaneousChargeKg ?? 0)),
      2,
    ),
    rows: blasts.map((blast) => ({
      reference: blast.reference,
      firedAt: blast.firedAt,
      holes: blast.holeCount ?? null,
      totalChargeKg: blast.totalChargeKg ?? null,
      instantaneousChargeKg: blast.instantaneousChargeKg ?? null,
    })),
    note: null,
  };
}

function vibrationSection({ records = [] }) {
  const measured = records.filter((record) => typeof record.peakMmPerSecond === 'number');
  if (measured.length === 0) {
    return {
      count: 0,
      highest: null,
      note: 'No ground vibration was recorded in the period.',
      rows: [],
    };
  }
  const highest = measured.reduce((best, record) =>
    record.peakMmPerSecond > best.peakMmPerSecond ? record : best,
  );
  return {
    count: measured.length,
    highest: highest.peakMmPerSecond,
    highestAt: highest.triggeredAt,
    highestReceptor: highest.receptorName ?? highest.receptorId ?? null,
    mean: roundTo(
      measured.reduce((sum, record) => sum + record.peakMmPerSecond, 0) / measured.length,
      3,
    ),
    rows: measured.map((record) => ({
      triggeredAt: record.triggeredAt,
      receptor: record.receptorName ?? record.receptorId ?? null,
      peakMmPerSecond: record.peakMmPerSecond,
      frequencyHz: record.peakFrequencyHz ?? null,
      limitMmPerSecond: record.limitMmPerSecond ?? null,
    })),
    note: null,
  };
}

function airblastSection({ records = [] }) {
  const measured = records.filter((record) => typeof record.airblastDb === 'number');
  if (measured.length === 0) {
    return { count: 0, highest: null, note: 'No airblast was recorded in the period.', rows: [] };
  }
  const highest = measured.reduce((best, record) =>
    record.airblastDb > best.airblastDb ? record : best,
  );
  return {
    count: measured.length,
    highest: highest.airblastDb,
    highestAt: highest.triggeredAt,
    rows: measured.map((record) => ({
      triggeredAt: record.triggeredAt,
      receptor: record.receptorName ?? record.receptorId ?? null,
      airblastDb: record.airblastDb,
    })),
    note: null,
  };
}

function exceedanceSection({ exceedances = [] }) {
  if (exceedances.length === 0) {
    return { count: 0, note: 'No limit was exceeded in the period.', rows: [] };
  }
  return {
    count: exceedances.length,
    rows: exceedances.map((item) => ({
      triggeredAt: item.triggeredAt,
      receptor: item.receptorName ?? item.receptorId ?? null,
      channels: (item.channels ?? []).join(' and '),
      measured: item.ground?.peakMmPerSecond ?? null,
      limit: item.ground?.limitMmPerSecond ?? null,
      action: item.action ?? 'reported to the regulator and the design reviewed',
    })),
    note: null,
  };
}

function complaintSection({ complaints = [] }) {
  if (complaints.length === 0) {
    return { count: 0, note: 'No complaints were received in the period.', rows: [] };
  }
  return {
    count: complaints.length,
    rows: complaints.map((complaint) => ({
      receivedAt: complaint.receivedAt,
      about: complaint.about,
      state: complaint.state,
      respondedAt: complaint.closedAt ?? null,
      outcome: complaint.outcome ?? 'under investigation',
    })),
    note: null,
  };
}

function misfireSection({ misfires = [] }) {
  if (misfires.length === 0) {
    return { count: 0, note: 'No misfires occurred in the period.', rows: [] };
  }
  return {
    count: misfires.length,
    rows: misfires.map((misfire) => ({
      discoveredAt: misfire.discoveredAt,
      blast: misfire.blastReference ?? misfire.blastId,
      kind: misfire.kind,
      holes: Array.isArray(misfire.holeNumbers)
        ? misfire.holeNumbers.join(', ')
        : misfire.holeNumbers,
      madeSafeAt: misfire.madeSafeAt ?? null,
    })),
    note: null,
  };
}

function explosivesSection({ explosives = [] }) {
  if (explosives.length === 0) {
    return { count: 0, note: 'No explosive was consumed in the period.', rows: [] };
  }
  return {
    count: explosives.length,
    totalKg: roundTo(
      explosives.reduce((sum, item) => sum + (item.quantity ?? 0), 0),
      2,
    ),
    rows: explosives.map((item) => ({
      product: item.productCode,
      quantity: item.quantity,
      unit: item.unit ?? 'kg',
    })),
    note: null,
  };
}

/** The pack as the files that actually get attached to the email. */
export function renderPack(pack) {
  return {
    'blasts.csv': toCsv(pack.blasting.rows, { newline: '\n' }),
    'vibration.csv': toCsv(pack.vibration.rows, { newline: '\n' }),
    'airblast.csv': toCsv(pack.airblast.rows, { newline: '\n' }),
    'exceedances.csv': toCsv(pack.exceedances.rows, { newline: '\n' }),
    'complaints.csv': toCsv(pack.complaints.rows, { newline: '\n' }),
    'summary.json': JSON.stringify({ header: pack.header, summary: pack.summary }, null, 2),
  };
}
