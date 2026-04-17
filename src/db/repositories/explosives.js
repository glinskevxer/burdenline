/**
 * Products, batches, magazines and the ledger.
 *
 * The ledger is the only table in this system that is written to and never
 * updated, and that is enforced here rather than by convention: there is no
 * update function for it at all. A line entered wrongly is corrected by a
 * correction line that points at it, which is what an inspector expects to see
 * and what makes a balance reconstructible at any past moment.
 */

import { newId } from '../../lib/ids.js';
import { pick } from '../../lib/guards.js';
import { ConflictError, ValidationError } from '../../lib/errors.js';
import { inTransaction } from '../connection.js';
import {
  insertRow,
  updateRow,
  getById,
  findById,
  listWhere,
  rowsToObjects,
  createRecord,
} from '../repository.js';
import { canApply, signedQuantity, magazineState } from '../../domain/magazine/stock.js';
import { prepared } from '../statements.js';
import { roundTo } from '../../lib/units.js';

export function createProduct(db, input, { clock }) {
  return createRecord(
    db,
    {
      table: 'product',
      prefix: 'prod',
      defaults: {
        densityKgM3: null,
        relativeWeightStrength: null,
        velocityOfDetonationMs: null,
        waterResistance: 'none',
        minimumDiameterMm: null,
        sleepTimeHours: null,
        unNumber: null,
        hazardDivision: null,
        compatibilityGroup: null,
        unitMassKg: null,
      },
    },
    {
      ...pick(input, [
        'id',
        'code',
        'name',
        'kind',
        'densityKgM3',
        'relativeWeightStrength',
        'velocityOfDetonationMs',
        'waterResistance',
        'minimumDiameterMm',
        'sleepTimeHours',
        'unNumber',
        'hazardDivision',
        'compatibilityGroup',
        'unitMassKg',
      ]),
      isExplosive: input.isExplosive === false ? 0 : 1,
    },
    { clock },
  );
}

export function getProduct(db, id) {
  return getById(db, 'product', id, { kind: 'product' });
}

export function findProductByCode(db, code) {
  const [found] = listWhere(db, 'product', { code }, { pageSize: 1 });
  return found ?? null;
}

export function listProducts(db, options = {}) {
  return listWhere(
    db,
    'product',
    { kind: options.kind, retiredAt: null },
    { orderBy: 'code', ...options },
  );
}

export function retireProduct(db, id, { clock }) {
  getProduct(db, id);
  updateRow(db, 'product', id, { retiredAt: clock.now(), updatedAt: clock.now() });
  return getProduct(db, id);
}

export function createMagazine(db, input, { clock }) {
  getById(db, 'site', input.siteId, { kind: 'site' });
  return createRecord(
    db,
    {
      table: 'magazine',
      prefix: 'mag',
      defaults: {
        licenceNumber: null,
        kind: 'store',
        detonatorLimit: null,
        eastingM: null,
        northingM: null,
        status: 'active',
      },
    },
    pick(input, [
      'id',
      'siteId',
      'name',
      'licenceNumber',
      'kind',
      'netExplosiveLimitKg',
      'detonatorLimit',
      'eastingM',
      'northingM',
      'status',
    ]),
    { clock },
  );
}

export function getMagazine(db, id) {
  return getById(db, 'magazine', id, { kind: 'magazine' });
}

export function listMagazines(db, siteId) {
  return listWhere(db, 'magazine', { siteId }, { orderBy: 'name' });
}

export function createBatch(db, input, { clock }) {
  getProduct(db, input.productId);
  return createRecord(
    db,
    {
      table: 'product_batch',
      prefix: 'batch',
      defaults: {
        manufacturedOn: null,
        expiresOn: null,
        supplier: null,
        deliveryNote: null,
        receivedAt: clock.now(),
      },
    },
    pick(input, [
      'id',
      'productId',
      'batchCode',
      'manufacturedOn',
      'expiresOn',
      'receivedAt',
      'supplier',
      'deliveryNote',
    ]),
    { clock },
  );
}

export function getBatch(db, id) {
  return getById(db, 'product_batch', id, { kind: 'batch' });
}

export function listBatches(db, productId) {
  return listWhere(db, 'product_batch', { productId }, { orderBy: 'expires_on' });
}

export function ledgerFor(db, magazineId, options = {}) {
  const rows = prepared(
    db,
    `SELECT l.*, b.batch_code, p.code AS product_code, p.kind AS product_kind
       FROM magazine_ledger l
       JOIN product_batch b ON b.id = l.batch_id
       JOIN product p ON p.id = b.product_id
       WHERE l.magazine_id = @magazineId
         AND (@from IS NULL OR l.occurred_at >= @from)
         AND (@to IS NULL OR l.occurred_at <= @to)
       ORDER BY l.occurred_at, l.id`,
  ).all({ magazineId, from: options.from ?? null, to: options.to ?? null });
  return rowsToObjects(rows);
}

export function ledgerForBlast(db, blastId) {
  const rows = db
    .prepare(
      `SELECT l.*, b.batch_code, p.code AS product_code
       FROM magazine_ledger l
       JOIN product_batch b ON b.id = l.batch_id
       JOIN product p ON p.id = b.product_id
       WHERE l.blast_id = @blastId
       ORDER BY l.occurred_at, l.id`,
    )
    .all({ blastId });
  return rowsToObjects(rows);
}

/**
 * Append a movement. The check and the write happen in one transaction so that
 * two people issuing from the same magazine at once cannot both be told there is
 * room.
 */
export function recordMovement(db, input, { clock }) {
  const magazine = getMagazine(db, input.magazineId);
  getBatch(db, input.batchId);
  const now = clock.now();
  return inTransaction(db, () => {
    const check = canApply(
      {
        movement: input.movement,
        quantity: input.quantity,
        massKg: input.massKg,
        batchId: input.batchId,
      },
      magazine,
      [],
      { batchIsDetonator: input.batchIsDetonator, balances: balanceRows(db, input.magazineId) },
    );
    if (!check.valid && !input.force) {
      throw new ConflictError('that movement cannot be made', { violations: check.violations });
    }
    const quantity = signedQuantity(input.movement, input.quantity);
    const line = {
      id: input.id ?? newId('led'),
      magazineId: input.magazineId,
      batchId: input.batchId,
      movement: input.movement,
      quantity,
      unit: input.unit ?? 'kg',
      massKg: input.massKg === undefined ? quantity : Math.sign(quantity) * Math.abs(input.massKg),
      occurredAt: input.occurredAt ?? now,
      recordedAt: now,
      personId: input.personId ?? null,
      blastId: input.blastId ?? null,
      reference: input.reference ?? null,
      reason: input.reason ?? null,
      correctsId: input.correctsId ?? null,
      createdAt: now,
    };
    insertRow(db, 'magazine_ledger', line);
    return line;
  });
}

export function correctMovement(db, { ledgerId, quantity, reason, personId }, { clock }) {
  const original = findById(db, 'magazine_ledger', ledgerId);
  if (!original) {
    throw new ValidationError('there is no ledger line to correct', [
      { path: 'ledgerId', message: 'unknown line', kind: 'missing' },
    ]);
  }
  if (!reason || reason.trim().length < 5) {
    throw new ValidationError('a correction needs a reason', [
      { path: 'reason', message: 'say why the line was wrong', kind: 'missing' },
    ]);
  }
  const now = clock.now();
  const line = {
    id: newId('led'),
    magazineId: original.magazineId,
    batchId: original.batchId,
    movement: 'correction',
    quantity,
    unit: original.unit,
    massKg: quantity,
    occurredAt: now,
    recordedAt: now,
    personId: personId ?? null,
    blastId: original.blastId,
    reason,
    correctsId: ledgerId,
    createdAt: now,
  };
  insertRow(db, 'magazine_ledger', line);
  return line;
}

/**
 * Per batch balances, summed in the database. Consumption is left out for the
 * same reason it is left out of the running balance: the issue already moved it.
 */
export function balanceRows(db, magazineId) {
  const rows = prepared(
    db,
    `SELECT l.batch_id AS batchId, l.magazine_id AS magazineId, l.unit AS unit,
            sum(l.quantity) AS quantity, sum(l.mass_kg) AS massKg,
            count(*) AS lineCount, max(l.occurred_at) AS lastMovementAt
       FROM magazine_ledger l
       WHERE l.magazine_id = ? AND l.movement <> 'consumption'
       GROUP BY l.batch_id, l.unit`,
  ).all(magazineId);
  return rows.map((row) => ({
    ...row,
    quantity: roundTo(row.quantity, 4),
    massKg: roundTo(row.massKg, 4),
  }));
}

export function stockFor(db, magazineId, options = {}) {
  const magazine = getMagazine(db, magazineId);
  if (options.from || options.to) {
    return magazineState(magazine, ledgerFor(db, magazineId, options), options);
  }
  return magazineState(magazine, [], { ...options, balances: balanceRows(db, magazineId) });
}
