/**
 * Firing a shot.
 *
 * The clearance lives in the database because it is filled in over an hour by
 * several people on radios, and the gate is asked at the moment somebody wants
 * to fire, not when the design was signed off. What the service adds over the
 * domain is the reading and writing, and one rule of its own: the gate is asked
 * again immediately before the transition is written, inside the same
 * transaction, so a clearance item that went stale while the confirmation dialog
 * was open cannot be fired through.
 */

import { newId } from '../lib/ids.js';
import { ConflictError, ValidationError } from '../lib/errors.js';
import { inTransaction } from '../db/connection.js';
import { insertRow, updateRow, rowsToObjects } from '../db/repository.js';
import {
  STANDARD_CHECKLIST,
  evaluateClearance,
  check as checkItem,
  timeRemaining,
} from '../domain/firing/clearance.js';
import { checkConditions, parseObservation } from '../domain/firing/weather.js';
import { checkFiringTime } from '../domain/firing/firing-windows.js';
import { mayFire } from '../domain/people/competency.js';
import { decide, assertMayFire } from '../domain/firing/gate.js';
import * as blasts from '../db/repositories/blasts.js';
import * as monitoring from '../db/repositories/monitoring.js';
import { rulesFor } from '../db/repositories/site-rules.js';

export function createFiringService({ db, clock, logger }) {
  const context = { clock };

  function startClearance({ blastId, template = STANDARD_CHECKLIST }) {
    const blast = blasts.getBlast(db, blastId);
    if (!['loaded', 'tied_in'].includes(blast.state)) {
      throw new ConflictError(`a clearance cannot start on a shot that is ${blast.state}`, {
        blastId,
        state: blast.state,
      });
    }
    const now = clock.now();
    return inTransaction(db, () => {
      db.prepare('DELETE FROM clearance_item WHERE blast_id = ?').run(blastId);
      for (const item of template) {
        insertRow(db, 'clearance_item', {
          id: newId('job'),
          blastId,
          itemKey: item.id,
          category: item.category,
          label: item.label,
          mandatory: item.mandatory ? 1 : 0,
          validForMinutes: item.validForMinutes,
          createdAt: now,
        });
      }
      return readClearance(blastId, template);
    });
  }

  function readClearance(blastId, template = STANDARD_CHECKLIST) {
    const rows = rowsToObjects(
      db.prepare('SELECT * FROM clearance_item WHERE blast_id = ? ORDER BY rowid').all(blastId),
    );
    if (rows.length === 0) {
      throw new ValidationError('that shot has no clearance started', [
        { path: 'blastId', message: 'start the clearance first', kind: 'missing' },
      ]);
    }
    const byKey = new Map(template.map((item) => [item.id, item]));
    return {
      blastId,
      items: rows.map((row) => ({
        id: row.itemKey,
        rowId: row.id,
        category: row.category,
        label: row.label,
        mandatory: row.mandatory === 1,
        validForMinutes: row.validForMinutes,
        requires: byKey.get(row.itemKey)?.requires ?? [],
        checkedAt: row.checkedAt,
        checkedBy: row.checkedBy,
        note: row.note,
      })),
    };
  }

  /** Tick one item off. The order rules live in the domain and are applied here. */
  function completeItem({ blastId, itemKey, by, note = null, at }) {
    const clearance = readClearance(blastId);
    const moment = at ?? clock.now();
    const updated = checkItem(clearance, itemKey, { at: moment, by, note });
    const item = updated.items.find((candidate) => candidate.id === itemKey);
    updateRow(db, 'clearance_item', item.rowId, {
      checkedAt: item.checkedAt,
      checkedBy: item.checkedBy,
      note: item.note,
    });
    return { clearance: updated, remaining: timeRemaining(updated, moment) };
  }

  function clearanceState({ blastId, at }) {
    return evaluateClearance(readClearance(blastId), at ?? clock.now());
  }

  /**
   * Ask everything. Design side checks are handed in because they were computed
   * when the design was approved; the day of checks are read fresh here.
   */
  function gate({
    blastId,
    at,
    design = {},
    observation,
    person,
    certificates = [],
    schedule,
    embargoes = [],
    zone = 'UTC',
    wetHoles = false,
    overrides = [],
  }) {
    const blast = blasts.getBlast(db, blastId);
    const moment = at ?? clock.now();
    const receptors = monitoring.listReceptors(db, blast.siteId).map((receptor) => ({
      id: receptor.id,
      name: receptor.name,
      occupied: receptor.occupied,
      bearingDeg: receptor.bearingDeg ?? 0,
    }));

    const inputs = {
      design: design.design ?? { violations: [] },
      charging: design.charging ?? { violations: [] },
      timing: design.timing ?? { violations: [] },
      vibration: design.vibration ?? { violations: [] },
      explosives: design.explosives ?? { violations: [] },
      competency: person
        ? mayFire({ person, certificates, onDate: moment.slice(0, 10), needs: design.needs ?? [] })
        : null,
      clearance: clearanceState({ blastId, at: moment }),
      weather: observation
        ? checkConditions({
            observation: parseObservation(observation),
            receptors,
            wetHoles,
            rules: rulesFor(db, blast.siteId, 'weather').values,
          })
        : null,
      schedule: schedule ? checkFiringTime({ instant: moment, zone, schedule, embargoes }) : null,
    };
    const decision = decide(inputs, { overrides });
    logger?.info?.(
      { blastId, mayFire: decision.mayFire, blockers: decision.blocking.length },
      'gate asked',
    );
    return { ...decision, blastId, at: moment, state: blast.state };
  }

  /**
   * Fire it. The gate is asked again inside the transaction that writes it, and
   * the shot passes through cleared on the way so the two cannot disagree.
   */
  function fire({ blastId, shotfirerId, firedAt, gateInputs }) {
    if (!shotfirerId) {
      throw new ValidationError('a shot is fired by a named shotfirer', [
        { path: 'shotfirerId', message: 'no shotfirer given', kind: 'missing' },
      ]);
    }
    const at = firedAt ?? clock.now();
    return inTransaction(db, () => {
      assertMayFire(gate({ ...gateInputs, blastId, at }));
      const blast = blasts.getBlast(db, blastId);
      if (blast.state === 'tied_in') {
        blasts.transition(
          db,
          blastId,
          'clear',
          { clearanceId: `clearance:${blastId}`, at },
          context,
        );
      }
      const result = blasts.transition(
        db,
        blastId,
        'fire',
        { shotfirerId, firedAt: at, at },
        context,
      );
      logger?.info?.({ blastId, shotfirerId, firedAt: at }, 'shot fired');
      return result;
    });
  }

  function reportMisfire({ blastId, reason, actorId }) {
    if (!reason || reason.trim().length < 5) {
      throw new ValidationError('a misfire is recorded with what was seen', [
        { path: 'reason', message: 'say what did not go', kind: 'missing' },
      ]);
    }
    return blasts.transition(db, blastId, 'report_misfire', { reason, actorId }, context);
  }

  function makeSafe({ blastId, shotfirerId, note }) {
    return blasts.transition(
      db,
      blastId,
      'make_safe',
      { shotfirerId, reason: note ?? null },
      context,
    );
  }

  return {
    startClearance,
    readClearance,
    completeItem,
    clearanceState,
    gate,
    fire,
    reportMisfire,
    makeSafe,
  };
}
