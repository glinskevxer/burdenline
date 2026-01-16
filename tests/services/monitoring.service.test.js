import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { migration as production } from '../../src/db/migrations/005_production.js';
import { createSite } from '../../src/db/repositories/sites.js';
import {
  createReceptor,
  listRecords,
  currentSiteLaw,
} from '../../src/db/repositories/monitoring.js';
import { createBlast, transition, recordDesignTotals } from '../../src/db/repositories/blasts.js';
import { createMonitoringService } from '../../src/services/monitoring.service.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';
import { insertRow } from '../../src/db/repository.js';
import { ValidationError, ConflictError } from '../../src/lib/errors.js';

let db;
let service;
let siteId;
let receptorId;
const clock = fixedClock('2025-09-03T09:00:00Z');
const context = { clock };

function vendorFile(rows) {
  return [
    'Minimate Plus Event Report',
    'Serial Number: BE-11482',
    'Trigger Level: 0.5',
    '',
    'Date Time,Tran,Tran Freq,Vert,Vert Freq,Long,Long Freq,Air,Air Freq',
    ...rows,
    '',
  ].join('\n');
}

function firedBlast(reference, firedAt, instantaneousChargeKg) {
  const blast = createBlast(db, { siteId, reference }, context);
  transition(db, blast.id, 'complete_design', {}, context);
  transition(db, blast.id, 'submit', {}, context);
  transition(db, blast.id, 'approve', { approverId: 'per_1' }, context);
  recordDesignTotals(db, blast.id, { instantaneousChargeKg }, context);
  transition(db, blast.id, 'load', { shotfirerId: 'per_1' }, context);
  transition(db, blast.id, 'tie_in', {}, context);
  transition(db, blast.id, 'clear', { clearanceId: 'chk_1' }, context);
  transition(db, blast.id, 'fire', { shotfirerId: 'per_1', firedAt }, context);
  return blast.id;
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations, production]);
  service = createMonitoringService({ db, clock, logger: silentLogger() });
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, context).id;
  insertRow(db, 'person', {
    id: 'per_1',
    name: 'M Cronin',
    roles: 'shotfirer',
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  receptorId = createReceptor(
    db,
    {
      siteId,
      name: 'Keeper cottage',
      structureClass: 'dwelling',
      easting: 1400,
      northing: 2000,
      monitored: true,
    },
    context,
  ).id;
});

afterEach(() => closeDatabase(db));

describe('ingest', () => {
  it('reads a vendor file and stores the records', () => {
    const result = service.ingest({
      siteId,
      text: vendorFile(['2025-09-02 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
      sourceFile: 'be11482.csv',
    });
    expect(result.format).toBe('instantel');
    expect(result.inserted).toBe(1);
    expect(listRecords(db, siteId)[0].distanceM).toBe(412);
  });

  it('counts a file uploaded twice as duplicates', () => {
    const text = vendorFile(['2025-09-02 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']);
    service.ingest({ siteId, text, receptorId, distanceM: 412 });
    const second = service.ingest({ siteId, text, receptorId, distanceM: 412 });
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(1);
  });
});

describe('matching records to shots', () => {
  it('suggests the shot a record heard', () => {
    const blastId = firedBlast('MDW-2025-014', '2025-09-02T13:04:09.000Z', 86);
    service.ingest({
      siteId,
      text: vendorFile(['2025-09-02 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    });
    const [suggestion] = service.suggestMatches({ siteId });
    expect(suggestion.matched).toBe(true);
    expect(suggestion.blast.id).toBe(blastId);
    expect(suggestion.ambiguous).toBe(false);
  });

  it('leaves an ambiguous record for a person', () => {
    firedBlast('MDW-2025-014', '2025-09-02T13:04:09.000Z', 86);
    firedBlast('MDW-2025-015', '2025-09-02T13:04:40.000Z', 90);
    service.ingest({
      siteId,
      text: vendorFile(['2025-09-02 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    });
    const result = service.attachUnambiguous({ siteId });
    expect(result.attached).toHaveLength(0);
    expect(result.left).toBe(1);
  });

  it('attaches every clear match', () => {
    firedBlast('MDW-2025-014', '2025-09-02T13:04:09.000Z', 86);
    service.ingest({
      siteId,
      text: vendorFile(['2025-09-02 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    });
    expect(service.attachUnambiguous({ siteId }).attached).toHaveLength(1);
    expect(service.suggestMatches({ siteId })).toHaveLength(0);
  });

  it('refuses to move a record to a second shot', () => {
    const first = firedBlast('MDW-2025-014', '2025-09-02T13:04:09.000Z', 86);
    const second = firedBlast('MDW-2025-016', '2025-09-05T13:04:09.000Z', 86);
    const { ids } = { ids: [] };
    service.ingest({
      siteId,
      text: vendorFile(['2025-09-02 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    });
    const recordId = listRecords(db, siteId)[0].id;
    service.attach({ recordId, blastId: first });
    expect(ids).toEqual([]);
    expect(() => service.attach({ recordId, blastId: second })).toThrow(ConflictError);
  });
});

describe('assess', () => {
  it('judges a quiet period as compliant', () => {
    service.ingest({
      siteId,
      text: vendorFile(['2025-09-02 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    });
    const assessment = service.assess({ siteId });
    expect(assessment.recordCount).toBe(1);
    expect(assessment.summary.compliant).toBe(true);
  });

  it('pulls an exceedance out', () => {
    service.ingest({
      siteId,
      text: vendorFile(['2025-09-02 13:04:11,26.0,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    });
    const assessment = service.assess({ siteId });
    expect(assessment.exceedances).toHaveLength(1);
    expect(assessment.summary.compliant).toBe(false);
  });

  it('sets aside a record with no receptor on it', () => {
    service.ingest({
      siteId,
      text: vendorFile(['2025-09-02 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      distanceM: 412,
    });
    expect(service.assess({ siteId }).withoutReceptor).toBe(1);
  });

  it('reports the records for one shot', () => {
    const blastId = firedBlast('MDW-2025-014', '2025-09-02T13:04:09.000Z', 86);
    service.ingest({
      siteId,
      text: vendorFile(['2025-09-02 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    });
    service.attachUnambiguous({ siteId });
    const report = service.forBlast({ blastId });
    expect(report.recordCount).toBe(1);
    expect(report.compliant).toBe(true);
  });
});

describe('refit', () => {
  /** Ten shots at falling scaled distances, each heard once. */
  function history() {
    for (let index = 0; index < 10; index += 1) {
      const day = String(10 + index).padStart(2, '0');
      const firedAt = `2025-09-${day}T13:00:00.000Z`;
      const charge = 40 + index * 15;
      const blastId = firedBlast(`MDW-2025-1${index}`, firedAt, charge);
      const distance = 200 + index * 40;
      const sd = distance / Math.sqrt(charge);
      const peak = 1140 * sd ** -1.6;
      service.ingest({
        siteId,
        text: vendorFile([
          `2025-09-${day} 13:00:02,${peak.toFixed(3)},14.0,0.5,26.0,0.4,18.0,110.0,12.0`,
        ]),
        receptorId,
        distanceM: distance,
      });
      const recordId = listRecords(db, siteId, { limit: 1 })[0].id;
      service.attach({ recordId, blastId });
    }
  }

  it('recovers the law the records came from', () => {
    history();
    const result = service.refit({ siteId });
    expect(result.fit.k).toBeGreaterThan(1100);
    expect(result.fit.k).toBeLessThan(1180);
    expect(result.fit.b).toBeCloseTo(1.6, 2);
    expect(currentSiteLaw(db, siteId).k).toBe(result.fit.k);
  });

  it('stores an upper bound when asked for one', () => {
    history();
    const mean = service.refit({ siteId });
    const bound = service.refit({ siteId, confidence: 0.95 });
    expect(bound.stored.k).toBeGreaterThanOrEqual(mean.stored.k);
    expect(bound.confidence).toBe(0.95);
  });

  it('supersedes the earlier fit', () => {
    history();
    service.refit({ siteId });
    service.refit({ siteId });
    expect(
      db.prepare('SELECT count(*) AS n FROM site_law WHERE superseded_at IS NOT NULL').get().n,
    ).toBe(1);
  });

  it('refuses to fit from a handful of records', () => {
    service.ingest({
      siteId,
      text: vendorFile(['2025-09-02 13:04:11,3.10,14.0,1.90,26.0,2.40,18.0,112.4,12.0']),
      receptorId,
      distanceM: 412,
    });
    expect(() => service.refit({ siteId })).toThrow(ValidationError);
  });

  it('refuses to hand out a law that was never fitted', () => {
    expect(() => service.currentLaw({ siteId })).toThrow(ConflictError);
  });
});
