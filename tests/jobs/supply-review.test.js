import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase, seedPerson } from '../helpers/database.js';
import { runJob } from '../../src/jobs/framework.js';
import { supplyReviewJob, noticeSweepJob } from '../../src/jobs/supply-review.js';
import { createSite } from '../../src/db/repositories/sites.js';
import {
  createProduct,
  createMagazine,
  createBatch,
  recordMovement,
} from '../../src/db/repositories/explosives.js';
import { createBlast } from '../../src/db/repositories/blasts.js';
import {
  planNotifications,
  recordNotificationOutcome,
} from '../../src/db/repositories/community.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';

let db;
let siteId;
let magazineId;
let productId;
const clock = fixedClock('2026-03-30T06:00:00Z');
const context = () => ({ db, clock, logger: silentLogger() });

beforeEach(async () => {
  db = await openTestDatabase();
  seedPerson(db);
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, { clock }).id;
  productId = createProduct(
    db,
    { code: 'ANFO-80', name: 'Ammonium nitrate fuel oil', kind: 'bulk_anfo', densityKgM3: 800 },
    { clock },
  ).id;
  magazineId = createMagazine(
    db,
    { siteId, name: 'Upper store', netExplosiveLimitKg: 8000 },
    { clock },
  ).id;
});

afterEach(() => closeTestDatabase(db));

function stockAndUse(held, days) {
  const batch = createBatch(db, { productId, batchCode: 'L2026-001' }, { clock });
  recordMovement(
    db,
    { magazineId, batchId: batch.id, movement: 'receipt', quantity: held, massKg: held },
    { clock },
  );
  for (const day of days) {
    recordMovement(
      db,
      {
        magazineId,
        batchId: batch.id,
        movement: 'issue',
        quantity: 900,
        massKg: 900,
        occurredAt: `${day}T13:00:00.000Z`,
        force: true,
      },
      { clock },
    );
  }
}

describe('the supply review sweep', () => {
  it('says nothing is needed from a store with no history', async () => {
    stockAndUse(4000, []);
    const result = await runJob(supplyReviewJob(), context());
    expect(result.found).toBe(0);
    expect(result.note).toContain('enough for the way it has been going');
  });

  it('finds a product about to run out', async () => {
    stockAndUse(4000, ['2026-02-02', '2026-02-09', '2026-02-16', '2026-02-23']);
    const result = await runJob(supplyReviewJob(), context());
    expect(result.found).toBeGreaterThan(0);
    expect(result.data.urgent[0].productCode).toBe('ANFO-80');
    expect(result.data.urgent[0].siteCode).toBe('MDW');
  });

  it('leaves a site with no magazine out of the count', async () => {
    createSite(db, { code: 'RCK', name: 'Rockfield' }, { clock });
    const result = await runJob(supplyReviewJob(), context());
    expect(result.examined).toBe(1);
  });
});

describe('the notice sweep', () => {
  function plannedBlast(plannedFor, reference = 'MDW-2026-050') {
    return createBlast(db, { siteId, reference, plannedFor }, { clock });
  }

  it('says nothing when there is nothing due', async () => {
    const result = await runJob(noticeSweepJob(), context());
    expect(result.examined).toBe(0);
    expect(result.found).toBe(0);
  });

  it('flags a shot due soon that nobody has been listed for', async () => {
    plannedBlast('2026-03-31T13:00:00.000Z');
    const result = await runJob(noticeSweepJob(), context());
    expect(result.found).toBe(1);
    expect(result.data.details[0].rule).toBe('notice.none_planned');
  });

  it('flags a neighbour who has not been told yet', async () => {
    const blast = plannedBlast('2026-03-31T13:00:00.000Z');
    planNotifications(
      db,
      blast.id,
      [
        {
          receptorId: null,
          channel: 'telephone',
          addressedTo: 'Keeper cottage',
          plannedFor: '2026-03-31T13:00:00.000Z',
        },
      ],
      { clock },
    );
    const result = await runJob(noticeSweepJob(), context());
    expect(result.data.details[0].rule).toBe('notice.not_sent');
  });

  it('says nothing once everybody has been told in time', async () => {
    const blast = plannedBlast('2026-04-01T13:00:00.000Z');
    const [notification] = planNotifications(
      db,
      blast.id,
      [
        {
          receptorId: null,
          channel: 'telephone',
          addressedTo: 'Keeper cottage',
          plannedFor: '2026-04-01T13:00:00.000Z',
        },
      ],
      { clock },
    );
    recordNotificationOutcome(db, notification.id, { sent: true }, { clock });
    const result = await runJob(noticeSweepJob(), context());
    expect(result.found).toBe(0);
  });

  it('looks no further ahead than it was told to', async () => {
    plannedBlast('2026-04-20T13:00:00.000Z');
    expect((await runJob(noticeSweepJob(), context())).examined).toBe(0);
    expect((await runJob(noticeSweepJob({ withinHours: 24 * 30 }), context())).examined).toBe(1);
  });

  it('leaves a shot that has already fired alone', async () => {
    const blast = plannedBlast('2026-03-31T13:00:00.000Z');
    db.prepare("UPDATE blast SET state = 'fired' WHERE id = ?").run(blast.id);
    expect((await runJob(noticeSweepJob(), context())).examined).toBe(0);
  });
});
