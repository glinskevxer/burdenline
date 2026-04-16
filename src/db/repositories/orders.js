/**
 * Ordering explosive and taking the delivery in.
 *
 * A delivery is not a database update, it is two things happening together: the
 * order line is marked delivered and the magazine takes the stock in. Doing one
 * without the other is how an order reads as delivered while the store shows
 * nothing, so they go in one transaction and the ledger line carries the order
 * reference.
 */

import { ConflictError, ValidationError, NotFoundError } from '../../lib/errors.js';
import { inTransaction } from '../connection.js';
import {
  getById,
  findById,
  listWhere,
  rowsToObjects,
  createRecord,
  updateRecord,
} from '../repository.js';
import { newId } from '../../lib/ids.js';
import { roundTo } from '../../lib/units.js';
import { createBatch, recordMovement, findProductByCode, listProducts } from './explosives.js';
import { consumptionProfile, reviewStore } from '../../domain/supply/reorder.js';

export const ORDER_STATES = ['draft', 'placed', 'part_delivered', 'delivered', 'cancelled'];

export function placeOrder(db, input, { clock, actorId = null }) {
  getById(db, 'site', input.siteId, { kind: 'site' });
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new ValidationError('an order needs at least one line', [
      { path: 'lines', message: 'no lines given', kind: 'missing' },
    ]);
  }
  const now = clock.now();
  return inTransaction(db, () => {
    const order = createRecord(
      db,
      {
        table: 'supply_order',
        prefix: 'rep',
        defaults: { expectedOn: null, note: null, state: 'placed' },
      },
      {
        siteId: input.siteId,
        supplier: input.supplier,
        reference: input.reference,
        placedAt: input.placedAt ?? now,
        placedBy: input.placedBy ?? actorId,
        expectedOn: input.expectedOn,
        state: input.state,
        note: input.note,
      },
      { clock },
    );
    for (const line of input.lines) {
      const product = findProductByCode(db, line.productCode);
      if (!product) {
        throw new ValidationError(`there is no product ${line.productCode}`, [
          { path: 'productCode', message: 'unknown product', kind: 'missing' },
        ]);
      }
      createRecord(
        db,
        {
          table: 'supply_order_line',
          prefix: 'rep',
          timestamps: ['createdAt'],
          defaults: { deliveredQuantity: 0 },
        },
        {
          orderId: order.id,
          productId: product.id,
          quantity: line.quantity,
          unit: line.unit ?? 'kg',
        },
        { clock },
      );
    }
    return withLines(db, order.id);
  });
}

export function getOrder(db, id) {
  return withLines(db, getById(db, 'supply_order', id, { kind: 'order' }).id);
}

export function listOrders(db, siteId, options = {}) {
  return listWhere(
    db,
    'supply_order',
    { siteId, state: options.state },
    { orderBy: 'placed_at DESC' },
  ).map((order) => withLines(db, order.id));
}

function withLines(db, orderId) {
  const order = findById(db, 'supply_order', orderId);
  const lines = rowsToObjects(
    db
      .prepare(
        `SELECT l.*, p.code AS product_code FROM supply_order_line l
         JOIN product p ON p.id = l.product_id WHERE l.order_id = ? ORDER BY p.code`,
      )
      .all(orderId),
  );
  return {
    ...order,
    lines,
    outstanding: lines
      .filter((line) => line.deliveredQuantity < line.quantity)
      .map((line) => ({
        productCode: line.productCode,
        outstanding: roundTo(line.quantity - line.deliveredQuantity, 3),
        unit: line.unit,
      })),
  };
}

/**
 * Take a delivery in. Each item names an order line and a batch code; the batch
 * is created if it is new, the stock goes into the magazine, and the line is
 * marked off.
 */
export function receiveDelivery(
  db,
  { orderId, magazineId, items, deliveryNote, personId },
  { clock },
) {
  const order = getOrder(db, orderId);
  if (['cancelled', 'delivered'].includes(order.state)) {
    throw new ConflictError(`that order is already ${order.state}`, { orderId });
  }
  getById(db, 'magazine', magazineId, { kind: 'magazine' });
  const now = clock.now();
  return inTransaction(db, () => {
    for (const item of items) {
      const line = order.lines.find((candidate) => candidate.productCode === item.productCode);
      if (!line) {
        throw new ValidationError(`${item.productCode} is not on that order`, [
          { path: 'productCode', message: 'no such line', kind: 'missing' },
        ]);
      }
      const remaining = roundTo(line.quantity - line.deliveredQuantity, 3);
      if (item.quantity > remaining + 1e-9) {
        throw new ConflictError(`${item.productCode} was ordered short of that`, {
          productCode: item.productCode,
          ordered: line.quantity,
          alreadyDelivered: line.deliveredQuantity,
        });
      }
      const batch = createBatch(
        db,
        {
          productId: line.productId,
          batchCode: item.batchCode,
          manufacturedOn: item.manufacturedOn ?? null,
          expiresOn: item.expiresOn ?? null,
          supplier: order.supplier,
          deliveryNote: deliveryNote ?? null,
          receivedAt: now,
        },
        { clock },
      );
      recordMovement(
        db,
        {
          magazineId,
          batchId: batch.id,
          movement: 'receipt',
          quantity: item.quantity,
          massKg: item.massKg ?? item.quantity,
          unit: line.unit,
          personId,
          reference: `${order.reference} ${deliveryNote ?? ''}`.trim(),
          occurredAt: now,
        },
        { clock },
      );
      db.prepare('UPDATE supply_order_line SET delivered_quantity = ? WHERE id = ?').run(
        roundTo(line.deliveredQuantity + item.quantity, 3),
        line.id,
      );
    }
    const refreshed = withLines(db, orderId);
    const state = refreshed.outstanding.length === 0 ? 'delivered' : 'part_delivered';
    updateRecord(
      db,
      { table: 'supply_order', kind: 'order', updatable: ['state'] },
      orderId,
      { state },
      { clock },
    );
    return withLines(db, orderId);
  });
}

export function cancelOrder(db, orderId, { clock, reason }) {
  const order = getOrder(db, orderId);
  if (order.lines.some((line) => line.deliveredQuantity > 0)) {
    throw new ConflictError('part of that order has already been delivered', { orderId });
  }
  return updateRecord(
    db,
    { table: 'supply_order', kind: 'order', updatable: ['state', 'note'] },
    orderId,
    { state: 'cancelled', note: reason ?? order.note },
    { clock },
  );
}

/** What is on order but not yet delivered, per product. */
export function onOrder(db, siteId) {
  const rows = db
    .prepare(
      `SELECT p.code AS product_code,
              sum(l.quantity - l.delivered_quantity) AS outstanding
       FROM supply_order o
       JOIN supply_order_line l ON l.order_id = o.id
       JOIN product p ON p.id = l.product_id
       WHERE o.site_id = ? AND o.state IN ('placed', 'part_delivered')
       GROUP BY p.code`,
    )
    .all(siteId);
  return Object.fromEntries(rows.map((row) => [row.product_code, roundTo(row.outstanding, 3)]));
}

/** The ordering screen: what is held, what is coming, and what to order. */
export function reviewSupply(db, siteId, { from, rules } = {}) {
  const site = getById(db, 'site', siteId, { kind: 'site' });
  const magazines = listWhere(db, 'magazine', { siteId: site.id, status: 'active' });
  if (magazines.length === 0) {
    throw new NotFoundError('magazine for site', siteId);
  }
  const coming = onOrder(db, site.id);
  const held = heldByProduct(
    db,
    magazines.map((magazine) => magazine.id),
  );
  const usage = usageByProduct(db, site.id, from);
  const items = listProducts(db).map((product) => ({
    productCode: product.code,
    held: held[product.code] ?? 0,
    onOrder: coming[product.code] ?? 0,
    profile: consumptionProfile(usage[product.code] ?? []),
  }));
  return reviewStore({ items, rules });
}

function heldByProduct(db, magazineIds) {
  if (magazineIds.length === 0) {
    return {};
  }
  const placeholders = magazineIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT p.code AS product_code, sum(l.quantity) AS held
       FROM magazine_ledger l
       JOIN product_batch b ON b.id = l.batch_id
       JOIN product p ON p.id = b.product_id
       WHERE l.magazine_id IN (${placeholders}) AND l.movement <> 'consumption'
       GROUP BY p.code`,
    )
    .all(...magazineIds);
  return Object.fromEntries(rows.map((row) => [row.product_code, roundTo(row.held, 3)]));
}

/**
 * Use is measured from what left the store, not from what went down the holes.
 * The two differ by whatever came back, and the store has to replace what left
 * it either way. It also means a site that has not filled its consumption
 * records in still gets a usable reorder point.
 */
function usageByProduct(db, siteId, from) {
  const rows = db
    .prepare(
      `SELECT p.code AS product_code, substr(l.occurred_at, 1, 10) AS on_date,
              sum(abs(l.quantity)) AS quantity
       FROM magazine_ledger l
       JOIN product_batch b ON b.id = l.batch_id
       JOIN product p ON p.id = b.product_id
       JOIN magazine m ON m.id = l.magazine_id
       WHERE m.site_id = @siteId AND l.movement = 'issue'
         AND (@from IS NULL OR l.occurred_at >= @from)
       GROUP BY p.code, on_date`,
    )
    .all({ siteId, from: from ?? null });
  const byProduct = {};
  for (const row of rows) {
    byProduct[row.product_code] = byProduct[row.product_code] ?? [];
    byProduct[row.product_code].push({ on: row.on_date, quantity: roundTo(row.quantity, 3) });
  }
  return byProduct;
}

export function orderIdFor(reference) {
  return newId('rep', { now: () => Date.parse(reference) || Date.now() });
}
