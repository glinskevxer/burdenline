/**
 * The audit trail.
 *
 * Written in the same transaction as the change it describes, which is the only
 * property that matters: an audit row that can be missing when the change went
 * through is worse than no audit at all, because it is trusted.
 *
 * Only the fields that actually changed are stored. A receptor row has twenty
 * columns and an edit usually touches one, and keeping the whole row twice makes
 * the trail unreadable at exactly the moment somebody is trying to read it.
 */

import { newId } from '../lib/ids.js';
import { insertRow, rowsToObjects } from './repository.js';

const REDACT = ['jwtSecret', 'token', 'password'];

export function diff(before, after) {
  const changed = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (REDACT.includes(key)) {
      continue;
    }
    const from = before?.[key];
    const to = after?.[key];
    if (from === to) {
      continue;
    }
    if (from === undefined && to === undefined) {
      continue;
    }
    changed[key] = { from: from ?? null, to: to ?? null };
  }
  return changed;
}

export function isMeaningful(changes, { ignore = ['updatedAt'] } = {}) {
  return Object.keys(changes).some((key) => !ignore.includes(key));
}

/**
 * Record a change. Returns null when nothing but a timestamp moved, so that a
 * save with no edits in it does not leave a trail entry saying nothing happened.
 */
export function recordChange(db, entry, { clock }) {
  const changes = diff(entry.before, entry.after);
  if (!entry.force && !isMeaningful(changes)) {
    return null;
  }
  const now = clock.now();
  const row = {
    id: newId('evt'),
    occurredAt: entry.at ?? now,
    actorId: entry.actorId ?? null,
    action: entry.action,
    entityKind: entry.entityKind,
    entityId: entry.entityId,
    beforeJson: entry.before ? JSON.stringify(pluck(entry.before, Object.keys(changes))) : null,
    afterJson: entry.after ? JSON.stringify(pluck(entry.after, Object.keys(changes))) : null,
    requestId: entry.requestId ?? null,
    createdAt: now,
  };
  insertRow(db, 'audit_entry', row);
  return { ...row, changes };
}

export function historyFor(db, entityKind, entityId, { limit = 100 } = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM audit_entry
       WHERE entity_kind = ? AND entity_id = ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
    )
    .all(entityKind, entityId, limit);
  return rowsToObjects(rows).map(hydrate);
}

export function byActor(db, actorId, { limit = 100 } = {}) {
  const rows = db
    .prepare('SELECT * FROM audit_entry WHERE actor_id = ? ORDER BY occurred_at DESC LIMIT ?')
    .all(actorId, limit);
  return rowsToObjects(rows).map(hydrate);
}

export function since(db, from, { limit = 500 } = {}) {
  const rows = db
    .prepare('SELECT * FROM audit_entry WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?')
    .all(from, limit);
  return rowsToObjects(rows).map(hydrate);
}

/** Wrap a write so the change and its trail entry go in together. */
export function audited(db, { clock, actorId, requestId, action, entityKind }, work) {
  const before = work.read();
  const after = work.write();
  const entry = recordChange(
    db,
    {
      actorId,
      requestId,
      action,
      entityKind,
      entityId: after?.id ?? before?.id,
      before,
      after,
    },
    { clock },
  );
  return { result: after, audit: entry };
}

function hydrate(row) {
  return {
    ...row,
    before: row.beforeJson ? JSON.parse(row.beforeJson) : null,
    after: row.afterJson ? JSON.parse(row.afterJson) : null,
  };
}

function pluck(source, keys) {
  const out = {};
  for (const key of keys) {
    out[key] = source[key] ?? null;
  }
  return out;
}
