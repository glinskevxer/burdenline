import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase } from '../../helpers/database.js';
import { createSite } from '../../../src/db/repositories/sites.js';
import { createBlast } from '../../../src/db/repositories/blasts.js';
import { createReceptor } from '../../../src/db/repositories/monitoring.js';
import {
  recordComplaint,
  getComplaint,
  listComplaints,
  advanceComplaint,
  complaintOverview,
  complaintClock,
  planNotifications,
  listNotifications,
  recordNotificationOutcome,
  notificationSummary,
} from '../../../src/db/repositories/community.js';
import { historyFor } from '../../../src/db/audit.js';
import { fixedClock } from '../../../src/lib/clock.js';
import { insertRow } from '../../../src/db/repository.js';
import {
  NotFoundError,
  ConflictError,
  StateError,
  ValidationError,
} from '../../../src/lib/errors.js';

let db;
let siteId;
let receptorId;
let blastId;
const clock = fixedClock('2025-12-08T09:00:00Z');
const context = { clock, actorId: 'per_1' };

function complaint(overrides = {}) {
  return recordComplaint(
    db,
    {
      siteId,
      receptorId,
      receivedAt: '2025-12-08T09:00:00.000Z',
      channel: 'telephone',
      about: 'vibration',
      description: 'the pictures came off the wall again just after two',
      ...overrides,
    },
    context,
  );
}

beforeEach(async () => {
  db = await openTestDatabase();
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, { clock }).id;
  insertRow(db, 'person', {
    id: 'per_1',
    name: 'M Cronin',
    roles: 'manager',
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  receptorId = createReceptor(
    db,
    { siteId, name: 'Keeper cottage', structureClass: 'dwelling', easting: 1300, northing: 2000 },
    { clock },
  ).id;
  blastId = createBlast(db, { siteId, reference: 'MDW-2025-014' }, { clock }).id;
});

afterEach(() => closeTestDatabase(db));

describe('complaints', () => {
  it('records one open', () => {
    const written = complaint();
    expect(written.state).toBe('open');
    expect(getComplaint(db, written.id).about).toBe('vibration');
  });

  it('refuses one against a site that is not there', () => {
    expect(() => complaint({ siteId: 'site_missing' })).toThrow(NotFoundError);
  });

  it('refuses one with nothing written down', () => {
    expect(() => complaint({ description: 'bad' })).toThrow(ValidationError);
  });

  it('leaves an audit entry', () => {
    const written = complaint();
    expect(historyFor(db, 'complaint', written.id)[0].action).toBe('complaint.received');
  });

  it('lists them newest first and filters by state', () => {
    const first = complaint();
    complaint({ receivedAt: '2025-12-09T09:00:00.000Z', about: 'dust' });
    advanceComplaint(db, first.id, 'respond', { outcome: 'answered by letter' }, context);
    expect(listComplaints(db, siteId)).toHaveLength(2);
    expect(listComplaints(db, siteId, { state: 'responded' })).toHaveLength(1);
  });

  it('moves one through its states', () => {
    const written = complaint();
    const investigating = advanceComplaint(db, written.id, 'investigate', {}, context);
    expect(investigating.state).toBe('investigating');
    const responded = advanceComplaint(
      db,
      written.id,
      'respond',
      { outcome: 'the readings were well under the limit' },
      context,
    );
    expect(responded.outcome).toContain('under the limit');
  });

  it('refuses a move that is not allowed', () => {
    const written = complaint();
    expect(() => advanceComplaint(db, written.id, 'close', {}, context)).toThrow(StateError);
  });

  it('stamps a closing time', () => {
    const written = complaint();
    advanceComplaint(db, written.id, 'respond', { outcome: 'answered' }, context);
    const closed = advanceComplaint(db, written.id, 'close', {}, context);
    expect(closed.closedAt).toBe(clock.now());
  });

  it('reports the overview with what is overdue', () => {
    complaint();
    const overview = complaintOverview(db, siteId, { asOf: '2025-12-20T09:00:00.000Z' });
    expect(overview.summary.count).toBe(1);
    expect(overview.summary.overdue).toBe(1);
  });

  it('reports the clock on one complaint', () => {
    const written = complaint();
    expect(complaintClock(db, written.id, '2025-12-09T09:00:00.000Z').hoursOpen).toBe(24);
  });
});

describe('notifications', () => {
  const planned = [
    {
      receptorId: null,
      channel: 'text_message',
      addressedTo: 'Keeper cottage',
      plannedFor: '2025-12-09T13:00:00.000Z',
    },
    {
      receptorId: null,
      channel: 'telephone',
      addressedTo: 'Saint Brendan school',
      plannedFor: '2025-12-09T13:00:00.000Z',
    },
  ];

  it('writes the planned list', () => {
    expect(planNotifications(db, blastId, planned, { clock })).toHaveLength(2);
    expect(listNotifications(db, blastId)).toHaveLength(2);
  });

  it('replaces what was planned rather than adding to it', () => {
    planNotifications(db, blastId, planned, { clock });
    planNotifications(db, blastId, [planned[0]], { clock });
    expect(listNotifications(db, blastId)).toHaveLength(1);
  });

  it('leaves the ones already sent alone when the plan is redone', () => {
    const written = planNotifications(db, blastId, planned, { clock });
    recordNotificationOutcome(db, written[0].id, { sent: true }, { clock });
    planNotifications(db, blastId, [planned[1]], { clock });
    expect(listNotifications(db, blastId)).toHaveLength(2);
  });

  it('marks one sent', () => {
    const written = planNotifications(db, blastId, planned, { clock });
    const sent = recordNotificationOutcome(db, written[0].id, { sent: true }, { clock });
    expect(sent.state).toBe('sent');
    expect(sent.sentAt).toBe(clock.now());
  });

  it('marks one failed with a reason', () => {
    const written = planNotifications(db, blastId, planned, { clock });
    const failed = recordNotificationOutcome(
      db,
      written[0].id,
      { sent: false, reason: 'the number was out of service' },
      { clock },
    );
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toContain('out of service');
  });

  it('refuses an outcome for a notification that is not there', () => {
    expect(() => recordNotificationOutcome(db, 'rep_missing', { sent: true }, { clock })).toThrow(
      ConflictError,
    );
  });

  it('summarises what is outstanding', () => {
    const written = planNotifications(db, blastId, planned, { clock });
    recordNotificationOutcome(db, written[0].id, { sent: true }, { clock });
    const summary = notificationSummary(db, blastId);
    expect(summary.count).toBe(2);
    expect(summary.outstanding).toBe(1);
  });

  it('refuses a plan against a shot that is not there', () => {
    expect(() => planNotifications(db, 'blast_missing', planned, { clock })).toThrow(NotFoundError);
  });
});
