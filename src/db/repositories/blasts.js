/**
 * Blasts, their events, their charge decks and their tie-in.
 *
 * The state on the blast row is a cache of the last event, and the events are
 * the record. Every transition writes both in one transaction, so a blast whose
 * state says fired always has a firing event behind it with a person and a time
 * on it. That property is what the whole post blast investigation rests on and
 * it is not left to a service to remember.
 */

import { newId } from '../../lib/ids.js';
import { ConflictError } from '../../lib/errors.js';
import { inTransaction } from '../connection.js';
import {
  insertRow,
  updateRow,
  getById,
  findById,
  listWhere,
  rowsToObjects,
  countWhere,
} from '../repository.js';
import { apply } from '../../domain/firing/lifecycle.js';

export function createBlast(db, input, { clock }) {
  getById(db, 'site', input.siteId, { kind: 'site' });
  const now = clock.now();
  const blast = {
    id: input.id ?? newId('blast'),
    siteId: input.siteId,
    patternId: input.patternId ?? null,
    reference: input.reference,
    state: 'draft',
    designedBy: input.designedBy ?? null,
    plannedFor: input.plannedFor ?? null,
    note: input.note ?? null,
    createdAt: now,
    updatedAt: now,
  };
  insertRow(db, 'blast', blast);
  return blast;
}

export function getBlast(db, id) {
  return getById(db, 'blast', id, { kind: 'blast' });
}

export function findBlast(db, id) {
  return findById(db, 'blast', id);
}

export function findBlastByReference(db, reference) {
  const [found] = listWhere(db, 'blast', { reference }, { pageSize: 1 });
  return found ?? null;
}

export function listBlasts(db, siteId, options = {}) {
  return listWhere(
    db,
    'blast',
    { siteId, state: options.state, patternId: options.patternId },
    { orderBy: 'created_at DESC', ...options },
  );
}

export function eventsFor(db, blastId) {
  const rows = db
    .prepare('SELECT * FROM blast_event WHERE blast_id = ? ORDER BY occurred_at, id')
    .all(blastId);
  return rowsToObjects(rows);
}

/**
 * Move a blast through the lifecycle. The domain decides whether the move is
 * legal; this writes the event and the new state together or neither.
 */
export function transition(db, blastId, action, context, { clock }) {
  const blast = getBlast(db, blastId);
  const now = clock.now();
  const { blast: next, event } = apply(blast, action, { ...context, at: context.at ?? now });
  return inTransaction(db, () => {
    const record = {
      id: newId('evt'),
      blastId,
      action: event.action,
      stateFrom: event.from,
      stateTo: event.to,
      occurredAt: event.at ?? now,
      actorId: event.by ?? null,
      reason: event.reason ?? null,
      payload: context.payload ? JSON.stringify(context.payload) : null,
      createdAt: now,
    };
    insertRow(db, 'blast_event', record);
    updateRow(db, 'blast', blastId, {
      state: next.state,
      updatedAt: now,
      ...(action === 'fire'
        ? { firedAt: context.firedAt ?? now, shotfirerId: context.shotfirerId }
        : {}),
      ...(action === 'approve' ? { approvedBy: context.approverId } : {}),
    });
    return { blast: getBlast(db, blastId), event: record };
  });
}

export function recordDesignTotals(db, blastId, totals, { clock }) {
  const blast = getBlast(db, blastId);
  if (['fired', 'closed', 'abandoned'].includes(blast.state)) {
    throw new ConflictError(`the totals of a ${blast.state} shot cannot be changed`, { blastId });
  }
  updateRow(db, 'blast', blastId, {
    totalChargeKg: totals.totalChargeKg ?? null,
    instantaneousChargeKg: totals.instantaneousChargeKg ?? null,
    holeCount: totals.holeCount ?? null,
    volumeM3: totals.volumeM3 ?? null,
    powderFactorKgM3: totals.powderFactorKgM3 ?? null,
    updatedAt: clock.now(),
  });
  return getBlast(db, blastId);
}

/** Write the whole load sheet for a shot: one row per deck per hole. */
export function replaceDecks(db, blastId, decks, { clock }) {
  getBlast(db, blastId);
  const now = clock.now();
  return inTransaction(db, () => {
    db.prepare('DELETE FROM charge_deck WHERE blast_id = ?').run(blastId);
    const statement = db.prepare(`
      INSERT INTO charge_deck (id, blast_id, hole_id, deck_number, kind, product_id, batch_id,
        from_toe_m, to_toe_m, mass_kg, primed, booster_count, in_hole_delay_ms, created_at)
      VALUES (@id, @blastId, @holeId, @deckNumber, @kind, @productId, @batchId,
        @fromToeM, @toToeM, @massKg, @primed, @boosterCount, @inHoleDelayMs, @now)
    `);
    let written = 0;
    for (const deck of decks) {
      statement.run({
        id: deck.id ?? newId('plan'),
        blastId,
        holeId: deck.holeId,
        deckNumber: deck.deckNumber,
        kind: deck.kind,
        productId: deck.productId ?? null,
        batchId: deck.batchId ?? null,
        fromToeM: deck.fromToeM,
        toToeM: deck.toToeM,
        massKg: deck.massKg ?? 0,
        primed: deck.primed ? 1 : 0,
        boosterCount: deck.boosterCount ?? 0,
        inHoleDelayMs: deck.inHoleDelayMs ?? null,
        now,
      });
      written += 1;
    }
    return { blastId, deckCount: written };
  });
}

export function decksFor(db, blastId) {
  const rows = db
    .prepare(
      `SELECT d.*, h.hole_number FROM charge_deck d
       JOIN hole h ON h.id = d.hole_id
       WHERE d.blast_id = ?
       ORDER BY h.hole_number, d.deck_number`,
    )
    .all(blastId);
  return rowsToObjects(rows);
}

export function replaceTieIn(db, blastId, connectors, { clock }) {
  getBlast(db, blastId);
  const now = clock.now();
  return inTransaction(db, () => {
    db.prepare('DELETE FROM tie_in_connector WHERE blast_id = ?').run(blastId);
    const statement = db.prepare(`
      INSERT INTO tie_in_connector (id, blast_id, from_hole, to_hole, delay_ms, detonator_code, created_at)
      VALUES (@id, @blastId, @fromHole, @toHole, @delayMs, @detonatorCode, @now)
    `);
    for (const connector of connectors) {
      statement.run({
        id: newId('det'),
        blastId,
        fromHole: connector.fromHole,
        toHole: connector.toHole,
        delayMs: connector.delayMs,
        detonatorCode: connector.detonatorCode ?? null,
        now,
      });
    }
    return { blastId, connectorCount: connectors.length };
  });
}

export function tieInFor(db, blastId) {
  const rows = db
    .prepare('SELECT * FROM tie_in_connector WHERE blast_id = ? ORDER BY from_hole, to_hole')
    .all(blastId);
  return rowsToObjects(rows);
}

export function blastCount(db, siteId, state) {
  return countWhere(db, 'blast', { siteId, state });
}
