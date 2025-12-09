/**
 * Prices and cost rates.
 *
 * Both are effective dated and neither is ever edited in place. Setting a new
 * price closes the old one on the day the new one starts, so the history stays
 * intact and a shot fired in March still costs what it cost in March. An edit in
 * place would silently rewrite every report that has ever been produced.
 */

import { newId } from '../../lib/ids.js';
import { ValidationError, ConflictError } from '../../lib/errors.js';
import { inTransaction } from '../connection.js';
import { insertRow, updateRow, getById, rowsToObjects } from '../repository.js';
import { priceOn, rateOn, COST_KINDS } from '../../domain/costing/blast-cost.js';

const UNITS = ['kg', 'each', 'metre', 'hour', 'shot', 'tonne'];

export function setPrice(db, input, { clock }) {
  const product = getById(db, 'product', input.productId, { kind: 'product' });
  if (!(input.pricePerUnit >= 0)) {
    throw new ValidationError('a price cannot be negative', [
      { path: 'pricePerUnit', message: 'must be zero or more', kind: 'range' },
    ]);
  }
  const from = input.effectiveFrom ?? clock.date();
  const now = clock.now();
  return inTransaction(db, () => {
    db.prepare(
      `UPDATE product_price SET effective_to = @from
       WHERE product_id = @productId AND effective_to IS NULL AND effective_from < @from`,
    ).run({ productId: product.id, from });
    const row = {
      id: newId('rep'),
      productId: product.id,
      unit: input.unit ?? 'kg',
      pricePerUnit: input.pricePerUnit,
      currency: input.currency ?? 'EUR',
      effectiveFrom: from,
      effectiveTo: null,
      supplier: input.supplier ?? null,
      createdAt: now,
    };
    insertRow(db, 'product_price', row);
    return row;
  });
}

export function priceHistory(db, productId) {
  const rows = db
    .prepare('SELECT * FROM product_price WHERE product_id = ? ORDER BY effective_from DESC')
    .all(productId);
  return rowsToObjects(rows);
}

/** Every price in the catalogue in the shape the costing domain reads. */
export function priceBook(db) {
  const rows = db
    .prepare(
      `SELECT p.code AS product_code, pr.unit, pr.price_per_unit, pr.currency,
              pr.effective_from, pr.effective_to
       FROM product_price pr JOIN product p ON p.id = pr.product_id`,
    )
    .all();
  return rowsToObjects(rows);
}

export function currentPrice(db, productCode, onDate) {
  return priceOn(priceBook(db), productCode, onDate);
}

export function setRate(db, input, { clock }) {
  getById(db, 'site', input.siteId, { kind: 'site' });
  if (!COST_KINDS.includes(input.kind)) {
    throw new ValidationError(`${input.kind} is not something this costs`, [
      { path: 'kind', message: `expected one of ${COST_KINDS.join(', ')}`, kind: 'enum' },
    ]);
  }
  if (!UNITS.includes(input.unit)) {
    throw new ValidationError(`${input.unit} is not a unit a rate is charged in`, [
      { path: 'unit', message: `expected one of ${UNITS.join(', ')}`, kind: 'enum' },
    ]);
  }
  const from = input.effectiveFrom ?? clock.date();
  const now = clock.now();
  return inTransaction(db, () => {
    db.prepare(
      `UPDATE cost_rate SET effective_to = @from
       WHERE site_id = @siteId AND kind = @kind AND effective_to IS NULL AND effective_from < @from`,
    ).run({ siteId: input.siteId, kind: input.kind, from });
    const row = {
      id: newId('rep'),
      siteId: input.siteId,
      kind: input.kind,
      rate: input.rate,
      unit: input.unit,
      currency: input.currency ?? 'EUR',
      effectiveFrom: from,
      effectiveTo: null,
      note: input.note ?? null,
      createdAt: now,
    };
    insertRow(db, 'cost_rate', row);
    return row;
  });
}

export function rateBook(db, siteId) {
  const rows = db.prepare('SELECT * FROM cost_rate WHERE site_id = ?').all(siteId);
  return rowsToObjects(rows);
}

export function currentRate(db, siteId, kind, onDate) {
  return rateOn(rateBook(db, siteId), kind, onDate);
}

/** Close a price or a rate without opening a new one, for a product being dropped. */
export function endPrice(db, priceId, { clock, on }) {
  const price = getById(db, 'product_price', priceId, { kind: 'price' });
  if (price.effectiveTo) {
    throw new ConflictError('that price has already ended', { priceId });
  }
  const to = on ?? clock.date();
  if (to <= price.effectiveFrom) {
    throw new ValidationError('a price cannot end before it started', [
      { path: 'on', message: `the price starts on ${price.effectiveFrom}`, kind: 'range' },
    ]);
  }
  updateRow(db, 'product_price', priceId, { effectiveTo: to });
  return getById(db, 'product_price', priceId, { kind: 'price' });
}

export const rateUnits = UNITS;
