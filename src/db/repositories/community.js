/**
 * Complaints and notifications.
 *
 * Both are records of a conversation with somebody outside the quarry, and both
 * are read back under pressure: after a complaint, at a planning review, or by a
 * regulator. So neither is ever deleted, a complaint carries its own state
 * machine, and every move through it leaves an audit entry with who made it.
 */

import { newId } from '../../lib/ids.js';
import { ConflictError } from '../../lib/errors.js';
import { inTransaction } from '../connection.js';
import {
  insertRow,
  updateRow,
  getById,
  findById,
  rowsToObjects,
  listWhere,
} from '../repository.js';
import {
  parseComplaint,
  advance,
  responseState,
  summarise as summariseComplaints,
} from '../../domain/community/complaints.js';
import {
  parseNotification,
  markSent,
  markFailed,
  summarise as summariseNotices,
} from '../../domain/community/notifications.js';
import { recordChange } from '../audit.js';

export function recordComplaint(db, input, { clock, actorId = null }) {
  getById(db, 'site', input.siteId, { kind: 'site' });
  const complaint = parseComplaint({ ...input, receivedBy: input.receivedBy ?? actorId });
  const now = clock.now();
  const row = {
    id: newId('rep'),
    siteId: complaint.siteId,
    receptorId: complaint.receptorId,
    blastId: complaint.blastId,
    receivedAt: complaint.receivedAt,
    receivedBy: complaint.receivedBy,
    channel: complaint.channel,
    complainant: complaint.complainant,
    contact: complaint.contact,
    about: complaint.about,
    description: complaint.description,
    occurredAt: complaint.occurredAt,
    state: 'open',
    createdAt: now,
    updatedAt: now,
  };
  return inTransaction(db, () => {
    insertRow(db, 'complaint', row);
    recordChange(
      db,
      {
        actorId,
        action: 'complaint.received',
        entityKind: 'complaint',
        entityId: row.id,
        before: null,
        after: { about: row.about, channel: row.channel },
        force: true,
      },
      { clock },
    );
    return row;
  });
}

export function getComplaint(db, id) {
  return getById(db, 'complaint', id, { kind: 'complaint' });
}

export function listComplaints(db, siteId, options = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM complaint
       WHERE site_id = @siteId
         AND (@state IS NULL OR state = @state)
         AND (@from IS NULL OR received_at >= @from)
         AND (@to IS NULL OR received_at <= @to)
       ORDER BY received_at DESC
       LIMIT @limit`,
    )
    .all({
      siteId,
      state: options.state ?? null,
      from: options.from ?? null,
      to: options.to ?? null,
      limit: options.limit ?? 200,
    });
  return rowsToObjects(rows);
}

export function advanceComplaint(db, id, action, context, { clock, actorId = null }) {
  const complaint = getComplaint(db, id);
  const moved = advance(complaint, action, { ...context, at: clock.now() });
  return inTransaction(db, () => {
    updateRow(db, 'complaint', id, {
      state: moved.state,
      outcome: moved.outcome,
      closedAt: moved.closedAt,
      updatedAt: clock.now(),
    });
    recordChange(
      db,
      {
        actorId,
        action: `complaint.${action}`,
        entityKind: 'complaint',
        entityId: id,
        before: { state: complaint.state },
        after: { state: moved.state },
      },
      { clock },
    );
    return getComplaint(db, id);
  });
}

export function complaintOverview(db, siteId, { asOf, ...options } = {}) {
  const complaints = listComplaints(db, siteId, options);
  return { complaints, summary: summariseComplaints(complaints, asOf) };
}

export function complaintClock(db, id, asOf) {
  return responseState(getComplaint(db, id), asOf);
}

export function planNotifications(db, blastId, notifications, { clock }) {
  getById(db, 'blast', blastId, { kind: 'blast' });
  const now = clock.now();
  return inTransaction(db, () => {
    db.prepare("DELETE FROM notification WHERE blast_id = ? AND state = 'planned'").run(blastId);
    const written = [];
    for (const input of notifications) {
      const notification = parseNotification({ ...input, blastId });
      const row = {
        id: newId('rep'),
        blastId,
        receptorId: notification.receptorId,
        channel: notification.channel,
        addressedTo: notification.addressedTo,
        plannedFor: notification.plannedFor,
        sentAt: notification.sentAt,
        state: notification.state,
        failureReason: notification.failureReason,
        createdAt: now,
      };
      insertRow(db, 'notification', row);
      written.push(row);
    }
    return written;
  });
}

export function listNotifications(db, blastId) {
  return listWhere(db, 'notification', { blastId }, { orderBy: 'addressed_to' });
}

export function recordNotificationOutcome(db, id, { sent, reason }, { clock }) {
  const row = findById(db, 'notification', id);
  if (!row) {
    throw new ConflictError('there is no notification with that id', { notificationId: id });
  }
  const updated = sent
    ? markSent(toDomain(row), clock.now())
    : markFailed(toDomain(row), reason ?? 'no answer');
  updateRow(db, 'notification', id, {
    state: updated.state,
    sentAt: updated.sentAt,
    failureReason: updated.failureReason,
  });
  return findById(db, 'notification', id);
}

export function notificationSummary(db, blastId) {
  return summariseNotices(listNotifications(db, blastId).map(toDomain));
}

function toDomain(row) {
  return {
    blastId: row.blastId,
    receptorId: row.receptorId,
    channel: row.channel,
    addressedTo: row.addressedTo,
    plannedFor: row.plannedFor,
    sentAt: row.sentAt,
    state: row.state,
    failureReason: row.failureReason,
  };
}
