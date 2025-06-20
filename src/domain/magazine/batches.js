/**
 * Batch traceability and shelf life.
 *
 * Every kilogram that goes down a hole has to be traceable to the batch it came
 * from and the delivery note that batch arrived on. That is a legal requirement
 * and it is also the only way to answer the question that actually gets asked
 * after a misfire: what else came off that pallet and where is it now.
 *
 * Shelf life is two separate clocks. A batch has an expiry from the maker, and a
 * pumped product that has been sitting in a hole has a sleep time, which is much
 * shorter and starts when the hole is loaded rather than when the batch was made.
 */

import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';
import { collector } from '../violations.js';

export const DEFAULT_BATCH_RULES = Object.freeze({
  warnWithinDays: 30,
  quarantineOnExpiry: true,
  maximumSleepOvershootHours: 0,
});

export function daysUntil(expiresOn, asOf) {
  if (!expiresOn) {
    return null;
  }
  const millis = Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(asOf);
  if (Number.isNaN(millis)) {
    throw new ValidationError(`${expiresOn} is not a date`, [
      { path: 'expiresOn', message: 'expected a calendar date', kind: 'type' },
    ]);
  }
  return Math.floor(millis / 86400000);
}

export function batchStatus(batch, asOf, rules = DEFAULT_BATCH_RULES) {
  const remaining = daysUntil(batch.expiresOn, asOf);
  if (remaining === null) {
    return { status: 'usable', daysRemaining: null };
  }
  if (remaining < 0) {
    return { status: 'expired', daysRemaining: remaining };
  }
  if (remaining <= rules.warnWithinDays) {
    return { status: 'expiring', daysRemaining: remaining };
  }
  return { status: 'usable', daysRemaining: remaining };
}

/**
 * Which batch to draw from. Nearest expiry first, so that stock is used in the
 * order it will go out of date rather than the order it happens to be stacked.
 */
export function pickBatch(batches, { quantity, asOf, rules = DEFAULT_BATCH_RULES }) {
  const usable = batches
    .filter((batch) => batchStatus(batch, asOf, rules).status !== 'expired')
    .filter((batch) => (batch.quantityHeld ?? 0) > 0)
    .sort((a, b) => {
      const left = a.expiresOn ?? '9999-12-31';
      const right = b.expiresOn ?? '9999-12-31';
      return left.localeCompare(right) || a.receivedAt.localeCompare(b.receivedAt);
    });
  const drawn = [];
  let outstanding = quantity;
  for (const batch of usable) {
    if (outstanding <= 0) {
      break;
    }
    const take = Math.min(batch.quantityHeld, outstanding);
    drawn.push({ batchId: batch.id, batchCode: batch.batchCode, quantity: roundTo(take, 4) });
    outstanding = roundTo(outstanding - take, 4);
  }
  return {
    drawn,
    satisfied: outstanding <= 0,
    shortfall: roundTo(Math.max(outstanding, 0), 4),
  };
}

/** How long a loaded hole has been sitting, and whether that is past the sleep time. */
export function sleepCheck({ loadedAt, asOf, sleepTimeHours, rules = DEFAULT_BATCH_RULES }) {
  if (!sleepTimeHours) {
    return { hoursAsleep: null, expired: false, sleepTimeHours: null };
  }
  const hours = roundTo((Date.parse(asOf) - Date.parse(loadedAt)) / 3600000, 2);
  if (Number.isNaN(hours)) {
    throw new ValidationError('a sleep check needs two instants', [
      { path: 'loadedAt', message: 'unreadable time', kind: 'type' },
    ]);
  }
  return {
    hoursAsleep: hours,
    sleepTimeHours,
    hoursRemaining: roundTo(sleepTimeHours - hours, 2),
    expired: hours > sleepTimeHours + rules.maximumSleepOvershootHours,
  };
}

/** Everything wrong with the batches a shot is about to be loaded from. */
export function checkBatchesForLoading(batches, asOf, rules = DEFAULT_BATCH_RULES) {
  const found = collector();
  for (const batch of batches) {
    const status = batchStatus(batch, asOf, rules);
    if (status.status === 'expired') {
      found.add(
        'batch.expired',
        `batch ${batch.batchCode} went out of date ${-status.daysRemaining} days ago`,
        {
          batchId: batch.id,
        },
      );
    } else if (status.status === 'expiring') {
      found.add(
        'batch.expiring',
        `batch ${batch.batchCode} expires in ${status.daysRemaining} days`,
        {
          batchId: batch.id,
        },
      );
    }
    if (batch.quarantined) {
      found.add('batch.quarantined', `batch ${batch.batchCode} is quarantined`, {
        batchId: batch.id,
      });
    }
  }
  const blocking = found.all().filter((item) => item.rule !== 'batch.expiring');
  return { valid: blocking.length === 0, violations: found.all(), blocking };
}

/**
 * The trace for one shot: every batch that went into it, how much, and the
 * delivery note it arrived on.
 */
export function traceForBlast(ledgerLines, batchesById) {
  const used = ledgerLines.filter((line) => line.movement === 'consumption');
  const byBatch = new Map();
  for (const line of used) {
    const current = byBatch.get(line.batchId) ?? { batchId: line.batchId, quantity: 0, massKg: 0 };
    current.quantity = roundTo(current.quantity + Math.abs(line.quantity), 4);
    current.massKg = roundTo(current.massKg + Math.abs(line.massKg), 4);
    byBatch.set(line.batchId, current);
  }
  return [...byBatch.values()].map((entry) => {
    const batch = batchesById.get(entry.batchId);
    return {
      ...entry,
      batchCode: batch?.batchCode ?? null,
      productCode: batch?.productCode ?? null,
      supplier: batch?.supplier ?? null,
      deliveryNote: batch?.deliveryNote ?? null,
      manufacturedOn: batch?.manufacturedOn ?? null,
    };
  });
}

/** Where else a batch went, which is the question asked after a misfire. */
export function whereElse(batchId, ledgerLines) {
  return ledgerLines
    .filter((line) => line.batchId === batchId && line.blastId)
    .reduce((blasts, line) => {
      if (!blasts.includes(line.blastId)) {
        blasts.push(line.blastId);
      }
      return blasts;
    }, []);
}
