/**
 * Moving explosive to a shot and accounting for it afterwards.
 *
 * The service owns the sequence, which is issue, then consume what actually went
 * down the holes, then return what came back, then reconcile. Each step is a
 * ledger append and none of them updates anything, so a shot part way through
 * the sequence reads correctly rather than reading as balanced.
 *
 * Batches are picked nearest expiry first and the picking happens here rather
 * than being typed in by whoever is at the magazine, because stock rotation done
 * by hand is stock rotation not done.
 */

import { ValidationError, ConflictError } from '../lib/errors.js';
import { roundTo } from '../lib/units.js';
import { pickBatch, checkBatchesForLoading, traceForBlast } from '../domain/magazine/batches.js';
import { reconcileShot, discrepancyReport } from '../domain/magazine/reconcile.js';
import { buildDay, verifyDay, renderDay } from '../domain/magazine/daybook.js';
import * as explosives from '../db/repositories/explosives.js';
import * as blasts from '../db/repositories/blasts.js';
import { rulesFor } from '../db/repositories/site-rules.js';

export function createMagazineService({ db, clock, logger }) {
  const context = { clock };

  /** Batches of a product held in a magazine, with what is left of each. */
  function heldBatches(magazineId, productId) {
    const state = explosives.stockFor(db, magazineId);
    const batches = explosives.listBatches(db, productId);
    return batches
      .map((batch) => {
        const held = state.batches.find((item) => item.batchId === batch.id);
        return { ...batch, quantityHeld: held?.quantity ?? 0 };
      })
      .filter((batch) => batch.quantityHeld > 0);
  }

  /**
   * Issue product for a shot. Draws from as many batches as it takes, refuses
   * outright if the stock is not there, and writes one ledger line per batch so
   * the trace survives.
   */
  function issueForBlast({ blastId, magazineId, items, personId, occurredAt }) {
    const blast = blasts.getBlast(db, blastId);
    if (!['approved', 'loaded'].includes(blast.state)) {
      throw new ConflictError(`explosive cannot be issued to a shot that is ${blast.state}`, {
        blastId,
        state: blast.state,
      });
    }
    const asOf = occurredAt ?? clock.now();
    const lines = [];
    for (const item of items) {
      const product = explosives.findProductByCode(db, item.productCode);
      if (!product) {
        throw new ValidationError(`there is no product ${item.productCode}`, [
          { path: 'productCode', message: 'unknown product', kind: 'missing' },
        ]);
      }
      const available = heldBatches(magazineId, product.id);
      const usable = checkBatchesForLoading(available, asOf);
      if (!usable.valid) {
        throw new ConflictError('the stock on hand cannot be issued', {
          violations: usable.blocking,
        });
      }
      const picked = pickBatch(available, { quantity: item.quantity, asOf });
      if (!picked.satisfied) {
        throw new ConflictError(`there is not enough ${item.productCode} in the magazine`, {
          productCode: item.productCode,
          shortfall: picked.shortfall,
        });
      }
      for (const draw of picked.drawn) {
        lines.push(
          explosives.recordMovement(
            db,
            {
              magazineId,
              batchId: draw.batchId,
              movement: 'issue',
              quantity: draw.quantity,
              massKg:
                item.unit === 'each' ? draw.quantity * (product.unitMassKg ?? 0) : draw.quantity,
              unit: item.unit ?? 'kg',
              blastId,
              personId,
              occurredAt: asOf,
              reference: blast.reference,
            },
            context,
          ),
        );
      }
    }
    logger?.info?.({ blastId, lines: lines.length }, 'explosive issued');
    return {
      blastId,
      lines,
      totalKg: roundTo(
        lines.reduce((sum, line) => sum + Math.abs(line.massKg), 0),
        3,
      ),
    };
  }

  /** What actually went down the holes, taken off the load sheet. */
  function consumeForBlast({ blastId, magazineId, personId, occurredAt }) {
    const blast = blasts.getBlast(db, blastId);
    const issued = explosives
      .ledgerForBlast(db, blastId)
      .filter((line) => line.movement === 'issue');
    if (issued.length === 0) {
      throw new ConflictError('nothing was issued to that shot', { blastId });
    }
    const decks = blasts.decksFor(db, blastId).filter((deck) => deck.kind === 'charge');
    const usedByBatch = new Map();
    for (const deck of decks) {
      const key = deck.batchId ?? issued[0].batchId;
      usedByBatch.set(key, roundTo((usedByBatch.get(key) ?? 0) + deck.massKg, 4));
    }
    const asOf = occurredAt ?? clock.now();
    const lines = [];
    for (const [batchId, massKg] of usedByBatch) {
      if (massKg <= 0) {
        continue;
      }
      lines.push(
        explosives.recordMovement(
          db,
          {
            magazineId,
            batchId,
            movement: 'consumption',
            quantity: massKg,
            massKg,
            blastId,
            personId,
            occurredAt: asOf,
            reference: blast.reference,
          },
          context,
        ),
      );
    }
    return {
      blastId,
      lines,
      totalKg: roundTo(
        lines.reduce((sum, line) => sum + Math.abs(line.massKg), 0),
        3,
      ),
    };
  }

  function returnFromBlast({ blastId, magazineId, items, personId, occurredAt }) {
    const asOf = occurredAt ?? clock.now();
    const lines = items.map((item) =>
      explosives.recordMovement(
        db,
        {
          magazineId,
          batchId: item.batchId,
          movement: 'return',
          quantity: item.quantity,
          massKg: item.massKg ?? item.quantity,
          unit: item.unit ?? 'kg',
          blastId,
          personId,
          occurredAt: asOf,
          reason: item.reason ?? null,
        },
        context,
      ),
    );
    return { blastId, lines };
  }

  function reconcile({ blastId, designed = [] }) {
    const blast = blasts.getBlast(db, blastId);
    const lines = explosives.ledgerForBlast(db, blastId);
    const reconciliation = reconcileShot(
      { blastId, designed, lines },
      { rules: rulesFor(db, blast.siteId, 'reconcile').values },
    );
    return {
      ...reconciliation,
      trace: traceForBlast(lines, new Map(lines.map((line) => [line.batchId, line]))),
      report: discrepancyReport(reconciliation, {
        reportedBy: null,
        occurredOn: clock.date(),
      }),
    };
  }

  function daybook({ siteId, magazineId, date, zone = 'UTC', openingBalances = {} }) {
    const lines = explosives.ledgerFor(db, magazineId).map((line) => ({
      ...line,
      personName: line.personId ?? 'unrecorded',
    }));
    const day = buildDay({ siteId, date, lines, openingBalances, zone });
    return {
      day,
      verification: verifyDay(
        day,
        lines.filter((line) => line.occurredAt.slice(0, 10) === date),
      ),
      csv: renderDay(day),
    };
  }

  return { heldBatches, issueForBlast, consumeForBlast, returnFromBlast, reconcile, daybook };
}
