/**
 * What is in the magazine.
 *
 * Stock is never stored as a number. It is the sum of an append only ledger, so
 * that any balance can be explained line by line and a correction leaves the
 * original entry standing. Two limits apply and they are checked separately: the
 * net explosive quantity the licence allows in the building, and, for a
 * detonator store, a count of detonators rather than a mass.
 *
 * Sign convention, and everything downstream depends on it: a movement that
 * brings explosive in is positive and one that takes it out is negative. The
 * caller passes the magnitude and the movement kind, and the sign is applied
 * here, because a hand written minus in a service was the cause of a magazine
 * once reading as holding negative four hundred kilograms.
 */

import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';
import { collector } from '../violations.js';

export const MOVEMENTS = [
  'receipt',
  'issue',
  'return',
  'consumption',
  'disposal',
  'transfer_in',
  'transfer_out',
  'correction',
  'stocktake',
];

const DIRECTION = {
  receipt: 1,
  return: 1,
  transfer_in: 1,
  issue: -1,
  consumption: -1,
  disposal: -1,
  transfer_out: -1,
  correction: 0,
  stocktake: 0,
};

export function directionOf(movement) {
  const direction = DIRECTION[movement];
  if (direction === undefined) {
    throw new ValidationError(`${movement} is not a magazine movement`, [
      { path: 'movement', message: `expected one of ${MOVEMENTS.join(', ')}`, kind: 'enum' },
    ]);
  }
  return direction;
}

/** The signed quantity a movement puts on the ledger. */
export function signedQuantity(movement, magnitude) {
  if (typeof magnitude !== 'number' || !Number.isFinite(magnitude)) {
    throw new ValidationError('a movement needs a quantity', [
      { path: 'quantity', message: 'expected a number', kind: 'type' },
    ]);
  }
  const direction = directionOf(movement);
  if (direction === 0) {
    return roundTo(magnitude, 4);
  }
  if (magnitude <= 0) {
    throw new ValidationError(`a ${movement} is written as a positive quantity`, [
      { path: 'quantity', message: 'give the magnitude, the sign is applied here', kind: 'range' },
    ]);
  }
  return roundTo(direction * magnitude, 4);
}

/** Balance per batch in one magazine, and the mass behind it. */
export function balances(lines) {
  const byBatch = new Map();
  for (const line of lines) {
    const key = line.batchId;
    const current = byBatch.get(key) ?? {
      batchId: key,
      magazineId: line.magazineId,
      unit: line.unit,
      quantity: 0,
      massKg: 0,
      lineCount: 0,
      lastMovementAt: null,
    };
    if (current.unit !== line.unit) {
      throw new ValidationError(`batch ${key} has lines in both ${current.unit} and ${line.unit}`, [
        { path: 'unit', message: 'a batch is counted in one unit', kind: 'conflict' },
      ]);
    }
    current.quantity = roundTo(current.quantity + line.quantity, 4);
    current.massKg = roundTo(current.massKg + line.massKg, 4);
    current.lineCount += 1;
    current.lastMovementAt =
      current.lastMovementAt === null || line.occurredAt > current.lastMovementAt
        ? line.occurredAt
        : current.lastMovementAt;
    byBatch.set(key, current);
  }
  return [...byBatch.values()];
}

export function netExplosiveQuantityKg(lines) {
  return roundTo(
    balances(lines).reduce((sum, batch) => sum + batch.massKg, 0),
    4,
  );
}

export function detonatorCount(lines, batchIsDetonator) {
  return balances(lines)
    .filter((batch) => batchIsDetonator(batch.batchId))
    .reduce((sum, batch) => sum + batch.quantity, 0);
}

/** Everything a stock check reports about one magazine. */
export function magazineState(magazine, lines, options = {}) {
  const perBatch = balances(lines);
  const netExplosiveKg = roundTo(
    perBatch.reduce((sum, batch) => sum + batch.massKg, 0),
    4,
  );
  const isDetonator = options.batchIsDetonator ?? (() => false);
  const detonators = perBatch
    .filter((batch) => isDetonator(batch.batchId))
    .reduce((sum, batch) => sum + batch.quantity, 0);
  const found = collector();
  found.atMost(
    netExplosiveKg,
    magazine.netExplosiveLimitKg,
    'magazine.over_licence',
    `${netExplosiveKg} kg in a magazine licensed for ${magazine.netExplosiveLimitKg} kg`,
    { magazineId: magazine.id },
  );
  if (magazine.detonatorLimit) {
    found.atMost(
      detonators,
      magazine.detonatorLimit,
      'magazine.over_detonator_limit',
      `${detonators} detonators in a store licensed for ${magazine.detonatorLimit}`,
      { magazineId: magazine.id },
    );
  }
  for (const batch of perBatch.filter((item) => item.quantity < 0)) {
    found.add('magazine.negative_stock', `batch ${batch.batchId} reads as ${batch.quantity}`, {
      magazineId: magazine.id,
      batchId: batch.batchId,
    });
  }
  return {
    magazineId: magazine.id,
    netExplosiveKg,
    detonatorCount: detonators,
    headroomKg: roundTo(magazine.netExplosiveLimitKg - netExplosiveKg, 4),
    utilisation: roundTo(netExplosiveKg / magazine.netExplosiveLimitKg, 4),
    batches: perBatch.filter((batch) => batch.quantity !== 0),
    emptyBatches: perBatch.filter((batch) => batch.quantity === 0).length,
    ...found.result(),
  };
}

/**
 * Can this movement be made? Checked before the line is written, because the
 * ledger is append only and a line that should not have been made can only be
 * corrected, never removed.
 */
export function canApply(movement, magazine, lines, options = {}) {
  const found = collector();
  const quantity = signedQuantity(movement.movement, movement.quantity);
  const massKg = movement.massKg ?? quantity;
  const state = magazineState(magazine, lines, options);
  const batch = state.batches.find((item) => item.batchId === movement.batchId);

  if (quantity < 0) {
    const held = batch?.quantity ?? 0;
    found.atLeast(
      held,
      Math.abs(quantity),
      'magazine.insufficient_stock',
      `${Math.abs(quantity)} asked for and ${held} held of batch ${movement.batchId}`,
      { batchId: movement.batchId },
    );
  }
  if (massKg > 0) {
    found.atMost(
      roundTo(state.netExplosiveKg + massKg, 4),
      magazine.netExplosiveLimitKg,
      'magazine.would_exceed_licence',
      `receiving ${massKg} kg would put the magazine over its licence`,
      { magazineId: magazine.id },
    );
  }
  if (magazine.status !== 'active') {
    found.add('magazine.not_active', `the magazine is ${magazine.status}`, {
      magazineId: magazine.id,
    });
  }
  return found.result({ quantity, massKg });
}
