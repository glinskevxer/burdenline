/**
 * Reconciling a shot.
 *
 * Four numbers have to agree at the end of a blast: what the design called for,
 * what was issued from the magazine, what went down the holes, and what came
 * back. Anything left over is unaccounted for, and unaccounted explosive is a
 * reportable event whatever the quantity, so the tolerance here is about
 * measurement noise on a bulk truck and nothing else. Counted items have no
 * tolerance at all: a detonator is either in a hole, back in the store, or
 * missing.
 */

import { roundTo } from '../../lib/units.js';
import { ValidationError } from '../../lib/errors.js';
import { collector } from '../violations.js';

export const DEFAULT_RECONCILE_RULES = Object.freeze({
  bulkTolerancePercent: 1.5,
  bulkToleranceKg: 5,
  countedToleranceUnits: 0,
  designTolerancePercent: 10,
});

/** Group the ledger lines for one shot into the four quantities. */
export function movementTotals(lines) {
  const totals = { issued: 0, consumed: 0, returned: 0, disposed: 0 };
  for (const line of lines) {
    const magnitude = Math.abs(line.quantity);
    switch (line.movement) {
      case 'issue':
        totals.issued = roundTo(totals.issued + magnitude, 4);
        break;
      case 'consumption':
        totals.consumed = roundTo(totals.consumed + magnitude, 4);
        break;
      case 'return':
        totals.returned = roundTo(totals.returned + magnitude, 4);
        break;
      case 'disposal':
        totals.disposed = roundTo(totals.disposed + magnitude, 4);
        break;
      default:
        break;
    }
  }
  return totals;
}

export function unaccounted(totals) {
  return roundTo(totals.issued - totals.consumed - totals.returned - totals.disposed, 4);
}

function toleranceFor(unit, issued, rules) {
  if (unit === 'each') {
    return rules.countedToleranceUnits;
  }
  return roundTo(Math.max(rules.bulkToleranceKg, (issued * rules.bulkTolerancePercent) / 100), 4);
}

/**
 * One product at a time, because a shot loaded with two products can balance
 * overall while one of them is short and the other over, which is exactly the
 * pattern a mis-keyed truck ticket makes.
 */
export function reconcileProduct({ productCode, unit, designedQuantity, lines }, options = {}) {
  const rules = { ...DEFAULT_RECONCILE_RULES, ...(options.rules ?? {}) };
  const totals = movementTotals(lines);
  const gap = unaccounted(totals);
  const tolerance = toleranceFor(unit, totals.issued, rules);
  const found = collector();

  if (Math.abs(gap) > tolerance) {
    found.add(
      gap > 0 ? 'reconcile.unaccounted' : 'reconcile.over_returned',
      `${Math.abs(gap)} ${unit} of ${productCode} ${gap > 0 ? 'unaccounted for' : 'returned beyond what was issued'}`,
      { productCode, actual: gap, required: tolerance },
    );
  }
  if (designedQuantity !== null && designedQuantity !== undefined && designedQuantity > 0) {
    const drift = roundTo(((totals.consumed - designedQuantity) / designedQuantity) * 100, 2);
    if (Math.abs(drift) > rules.designTolerancePercent) {
      found.add('reconcile.off_design', `${productCode} used ${drift} percent against the design`, {
        productCode,
        actual: totals.consumed,
        required: designedQuantity,
      });
    }
  }
  return {
    productCode,
    unit,
    designedQuantity: designedQuantity ?? null,
    ...totals,
    unaccounted: gap,
    toleranceApplied: tolerance,
    ...found.result(),
  };
}

export function reconcileShot({ blastId, designed = [], lines }, options = {}) {
  if (!blastId) {
    throw new ValidationError('a reconciliation is against one shot', [
      { path: 'blastId', message: 'no shot given', kind: 'missing' },
    ]);
  }
  const designedBy = new Map(designed.map((item) => [item.productCode, item]));
  const codes = new Set([
    ...designed.map((item) => item.productCode),
    ...lines.map((line) => line.productCode),
  ]);
  const products = [...codes].sort().map((productCode) => {
    const forProduct = lines.filter((line) => line.productCode === productCode);
    const design = designedBy.get(productCode);
    return reconcileProduct(
      {
        productCode,
        unit: forProduct[0]?.unit ?? design?.unit ?? 'kg',
        designedQuantity: design?.quantity ?? null,
        lines: forProduct,
      },
      options,
    );
  });
  const violations = products.flatMap((product) => product.violations);
  return {
    blastId,
    products,
    violations,
    balanced: violations.length === 0,
    totalIssued: roundTo(
      products.filter((p) => p.unit === 'kg').reduce((sum, product) => sum + product.issued, 0),
      3,
    ),
    totalConsumed: roundTo(
      products.filter((p) => p.unit === 'kg').reduce((sum, product) => sum + product.consumed, 0),
      3,
    ),
    reportable: violations.some((item) => item.rule !== 'reconcile.off_design'),
  };
}

/** The wording a reportable discrepancy goes to the regulator under. */
export function discrepancyReport(reconciliation, { reportedBy, occurredOn }) {
  if (!reconciliation.reportable) {
    return null;
  }
  const items = reconciliation.violations
    .filter((item) => item.rule !== 'reconcile.off_design')
    .map((item) => ({
      productCode: item.productCode,
      quantity: item.actual,
      rule: item.rule,
      message: item.message,
    }));
  return {
    blastId: reconciliation.blastId,
    occurredOn,
    reportedBy,
    items,
    totalItems: items.length,
    summary: `${items.length} product line${items.length === 1 ? '' : 's'} did not reconcile`,
  };
}
