import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase } from '../helpers/database.js';
import { seedDemoSite } from '../../src/fixtures/demo-site.js';
import { createReportingService } from '../../src/services/reporting.service.js';
import { createBlast, transition, recordDesignTotals } from '../../src/db/repositories/blasts.js';
import { recordInspection } from '../../src/db/repositories/postblast.js';
import { recordComplaint } from '../../src/db/repositories/community.js';
import { setPrice, setRate } from '../../src/db/repositories/costing.js';
import {
  recordMovement,
  findProductByCode,
  listBatches,
} from '../../src/db/repositories/explosives.js';
import { fixedClock } from '../../src/lib/clock.js';
import { NotFoundError } from '../../src/lib/errors.js';

let db;
let service;
let seeded;
let blastId;
const clock = fixedClock('2025-12-12T15:00:00Z');
const context = { clock };

function firedBlast(reference = 'MDW-2025-020', firedAt = '2025-12-11T13:00:00.000Z') {
  const blast = createBlast(
    db,
    { siteId: seeded.site.id, patternId: seeded.pattern.id, reference },
    context,
  );
  transition(db, blast.id, 'complete_design', {}, context);
  transition(db, blast.id, 'submit', {}, context);
  transition(db, blast.id, 'approve', { approverId: seeded.people[0].id }, context);
  recordDesignTotals(
    db,
    blast.id,
    {
      totalChargeKg: 1000,
      instantaneousChargeKg: 86,
      holeCount: 24,
      volumeM3: 3780,
      powderFactorKgM3: 0.26,
    },
    context,
  );
  transition(db, blast.id, 'load', { shotfirerId: seeded.people[2].id }, context);
  transition(db, blast.id, 'tie_in', {}, context);
  transition(db, blast.id, 'clear', { clearanceId: 'chk_1' }, context);
  transition(db, blast.id, 'fire', { shotfirerId: seeded.people[2].id, firedAt }, context);
  return blast.id;
}

function consume(quantity = 1000) {
  const product = findProductByCode(db, 'ANFO-80');
  const [batch] = listBatches(db, product.id);
  recordMovement(
    db,
    {
      magazineId: seeded.magazine.id,
      batchId: batch.id,
      movement: 'consumption',
      quantity,
      massKg: quantity,
      blastId,
      force: true,
    },
    context,
  );
}

beforeEach(async () => {
  db = await openTestDatabase();
  seeded = seedDemoSite(db, { clock });
  service = createReportingService({ db, clock });
  blastId = firedBlast();
  const product = findProductByCode(db, 'ANFO-80');
  setPrice(db, { productId: product.id, pricePerUnit: 1.2, effectiveFrom: '2025-01-01' }, context);
  setRate(
    db,
    {
      siteId: seeded.site.id,
      kind: 'drilling',
      rate: 6.5,
      unit: 'metre',
      effectiveFrom: '2025-01-01',
    },
    context,
  );
});

afterEach(() => closeTestDatabase(db));

describe('blastReport', () => {
  it('gathers the shot from every table it touches', () => {
    consume();
    const report = service.blastReport({ blastId });
    expect(report.blast.reference).toBe('MDW-2025-020');
    expect(report.events.length).toBeGreaterThan(5);
    expect(report.consumption[0].productCode).toBe('ANFO-80');
    expect(report.metresDrilled).toBeGreaterThan(300);
  });

  it('costs it at the prices in force on the day it fired', () => {
    consume();
    const report = service.blastReport({ blastId });
    expect(report.cost.parts.explosive).toBe(1200);
    expect(report.cost.parts.drilling).toBeGreaterThan(2000);
    expect(report.cost.perTonne).toBeGreaterThan(0);
  });

  it('says the muckpile cannot be dug before anybody walked it', () => {
    expect(service.blastReport({ blastId }).diggable).toBe(false);
  });

  it('takes the inspection in once it is there', () => {
    recordInspection(
      db,
      {
        blastId,
        inspectedAt: '2025-12-11T14:00:00.000Z',
        muckpileShape: 'moderate',
        throwM: 12,
        toeGrade: 'none',
      },
      { clock, holeCount: 24 },
    );
    const report = service.blastReport({ blastId });
    expect(report.inspection.muckpileShape).toBe('moderate');
    expect(report.diggable).toBe(true);
  });

  it('adds secondary breaking when it is handed in', () => {
    consume();
    setRate(
      db,
      {
        siteId: seeded.site.id,
        kind: 'secondary_breaking',
        rate: 95,
        unit: 'hour',
        effectiveFrom: '2025-01-01',
      },
      context,
    );
    const plain = service.blastReport({ blastId });
    const withHammer = service.blastReport({ blastId, secondaryBreakingHours: 8 });
    expect(withHammer.cost.total).toBeGreaterThan(plain.cost.total);
  });

  it('refuses a shot that is not there', () => {
    expect(() => service.blastReport({ blastId: 'blast_missing' })).toThrow(NotFoundError);
  });
});

describe('periodReport', () => {
  const from = '2025-12-01T00:00:00.000Z';
  const to = '2025-12-31T23:59:59.000Z';

  it('rolls the period up', () => {
    consume();
    const report = service.periodReport({ siteId: seeded.site.id, from, to });
    expect(report.blastCount).toBe(1);
    expect(report.volumeM3).toBe(3780);
    expect(report.powderFactorKgM3).toBeCloseTo(0.2646, 3);
    expect(report.tonnes).toBeGreaterThan(10000);
  });

  it('reports cost per tonne over the period', () => {
    consume();
    const report = service.periodReport({ siteId: seeded.site.id, from, to });
    expect(report.cost.perTonne).toBeGreaterThan(0);
    expect(report.cost.perBlast).toBe(report.cost.total);
  });

  it('leaves out a shot fired outside the period', () => {
    firedBlast('MDW-2025-021', '2025-11-01T13:00:00.000Z');
    expect(service.periodReport({ siteId: seeded.site.id, from, to }).blastCount).toBe(1);
  });

  it('counts the complaints raised in it', () => {
    recordComplaint(
      db,
      {
        siteId: seeded.site.id,
        receivedAt: '2025-12-12T09:00:00.000Z',
        channel: 'telephone',
        about: 'vibration',
        description: 'the house shook just after two yesterday',
      },
      context,
    );
    expect(service.periodReport({ siteId: seeded.site.id, from, to }).complaints.count).toBe(1);
  });

  it('has nothing to report for a quiet period', () => {
    const quiet = service.periodReport({
      siteId: seeded.site.id,
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-01-31T00:00:00.000Z',
    });
    expect(quiet.blastCount).toBe(0);
    expect(quiet.powderFactorKgM3).toBe(null);
  });
});

describe('scorecard', () => {
  const from = '2025-12-01T00:00:00.000Z';
  const to = '2025-12-31T23:59:59.000Z';

  it('is clean when nothing went wrong', () => {
    consume();
    const card = service.scorecard({ siteId: seeded.site.id, from, to });
    expect(card.clean).toBe(true);
    expect(card.failures).toEqual([]);
  });

  it('fails on a complaint left past its window', () => {
    recordComplaint(
      db,
      {
        siteId: seeded.site.id,
        receivedAt: '2025-12-01T09:00:00.000Z',
        channel: 'telephone',
        about: 'vibration',
        description: 'the house shook and nobody has rung me back',
      },
      context,
    );
    const card = service.scorecard({ siteId: seeded.site.id, from, to });
    expect(card.clean).toBe(false);
    expect(card.failures[0]).toContain('response window');
  });

  it('fails on a shot that threw rock', () => {
    recordInspection(
      db,
      {
        blastId,
        inspectedAt: '2025-12-11T14:00:00.000Z',
        muckpileShape: 'moderate',
        throwM: 40,
        toeGrade: 'none',
        flyrockObserved: true,
      },
      { clock, holeCount: 24 },
    );
    const card = service.scorecard({ siteId: seeded.site.id, from, to });
    expect(card.failures.some((failure) => failure.includes('flyrock'))).toBe(true);
  });
});
