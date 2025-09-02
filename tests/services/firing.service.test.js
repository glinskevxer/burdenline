import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { createSite } from '../../src/db/repositories/sites.js';
import { createReceptor } from '../../src/db/repositories/monitoring.js';
import { createBlast, transition, getBlast } from '../../src/db/repositories/blasts.js';
import { createFiringService } from '../../src/services/firing.service.js';
import { parsePerson, parseCertificate } from '../../src/domain/people/competency.js';
import { parseSchedule } from '../../src/domain/firing/firing-windows.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';
import { insertRow } from '../../src/db/repository.js';
import { ConflictError, ValidationError, RuleViolationError } from '../../src/lib/errors.js';

let db;
let service;
let siteId;
let blastId;

/** A Tuesday at two in the afternoon, local time. */
const noon = '2025-08-19T13:00:00.000Z';
const clock = fixedClock(noon);
const context = { clock };
const zone = 'Europe/Dublin';

const shotfirer = parsePerson({ id: 'per_1', name: 'M Cronin', roles: ['shotfirer'] });
const certificate = parseCertificate({
  id: 'cert_1',
  personId: 'per_1',
  kind: 'shotfirer',
  issuedOn: '2023-01-15',
  expiresOn: '2028-01-15',
  endorsements: ['bulk_explosive', 'shock_tube_initiation'],
});
const schedule = parseSchedule({ tuesday: [{ from: '13:00', to: '16:00' }] });
const observation = {
  observedAt: noon,
  windSpeedMs: 3,
  windBearingDeg: 90,
  temperatureC: 17,
  temperatureAt10mC: 16.2,
  visibilityM: 9000,
};

const ORDER = [
  'plant_withdrawn',
  'people_withdrawn',
  'zone_swept',
  'sentries_posted',
  'roads_stopped',
  'shot_area_clear',
  'warning_signal',
];

function loadedBlast() {
  const blast = createBlast(db, { siteId, reference: 'MDW-2025-014' }, context);
  transition(db, blast.id, 'complete_design', {}, context);
  transition(db, blast.id, 'submit', {}, context);
  transition(db, blast.id, 'approve', { approverId: 'per_1' }, context);
  transition(db, blast.id, 'load', { shotfirerId: 'per_1' }, context);
  transition(db, blast.id, 'tie_in', {}, context);
  return blast.id;
}

function walkClearance(at = noon) {
  service.startClearance({ blastId });
  for (const itemKey of ORDER) {
    service.completeItem({ blastId, itemKey, by: 'per_1', at });
  }
}

function gateInputs() {
  return {
    person: shotfirer,
    certificates: [certificate],
    observation,
    schedule,
    zone,
  };
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting]);
  service = createFiringService({ db, clock, logger: silentLogger() });
  siteId = createSite(db, { code: 'MDW', name: 'Midway', timeZone: zone }, context).id;
  insertRow(db, 'person', {
    id: 'per_1',
    name: 'M Cronin',
    roles: 'shotfirer',
    createdAt: noon,
    updatedAt: noon,
  });
  createReceptor(
    db,
    {
      siteId,
      name: 'Keeper cottage',
      structureClass: 'older_dwelling',
      easting: 1400,
      northing: 2000,
    },
    context,
  );
  blastId = loadedBlast();
});

afterEach(() => closeDatabase(db));

describe('startClearance', () => {
  it('writes the standard list against the shot', () => {
    const clearance = service.startClearance({ blastId });
    expect(clearance.items).toHaveLength(8);
    expect(clearance.items.every((item) => item.checkedAt === null)).toBe(true);
  });

  it('refuses to start one on a shot that is not loaded', () => {
    const draft = createBlast(db, { siteId, reference: 'MDW-2025-015' }, context);
    expect(() => service.startClearance({ blastId: draft.id })).toThrow(ConflictError);
  });

  it('replaces a clearance that was started earlier', () => {
    service.startClearance({ blastId });
    service.completeItem({ blastId, itemKey: 'plant_withdrawn', by: 'per_1' });
    const restarted = service.startClearance({ blastId });
    expect(restarted.items.every((item) => item.checkedAt === null)).toBe(true);
  });

  it('refuses to read a clearance nobody started', () => {
    expect(() => service.readClearance('blast_missing')).toThrow(ValidationError);
  });
});

describe('completeItem', () => {
  it('ticks an item off and says what goes stale first', () => {
    service.startClearance({ blastId });
    const result = service.completeItem({ blastId, itemKey: 'plant_withdrawn', by: 'per_1' });
    expect(result.clearance.items[0].checkedBy).toBe('per_1');
    expect(result.remaining.itemId).toBe('plant_withdrawn');
  });

  it('refuses an item out of order', () => {
    service.startClearance({ blastId });
    expect(() => service.completeItem({ blastId, itemKey: 'warning_signal', by: 'per_1' })).toThrow(
      /cannot be checked before/,
    );
  });

  it('persists across a read', () => {
    service.startClearance({ blastId });
    service.completeItem({ blastId, itemKey: 'plant_withdrawn', by: 'per_1' });
    const read = service.readClearance(blastId);
    expect(read.items.find((item) => item.id === 'plant_withdrawn').checkedAt).toBe(noon);
  });
});

describe('gate', () => {
  it('lets a properly prepared shot fire', () => {
    walkClearance();
    const decision = service.gate({ blastId, ...gateInputs() });
    expect(decision.mayFire).toBe(true);
    expect(decision.checksNotRun).toEqual([]);
  });

  it('stops a shot with the clearance half done', () => {
    service.startClearance({ blastId });
    service.completeItem({ blastId, itemKey: 'plant_withdrawn', by: 'per_1' });
    const decision = service.gate({ blastId, ...gateInputs() });
    expect(decision.mayFire).toBe(false);
    expect(decision.byArea.clearance).toBeGreaterThan(0);
  });

  it('stops a shot when the sweep has gone stale', () => {
    walkClearance('2025-08-19T12:00:00.000Z');
    const decision = service.gate({ blastId, ...gateInputs() });
    expect(decision.blocking.some((item) => item.rule === 'clearance.stale')).toBe(true);
  });

  it('stops a shot for lightning', () => {
    walkClearance();
    const decision = service.gate({
      blastId,
      ...gateInputs(),
      observation: { ...observation, lightningDistanceKm: 6 },
    });
    expect(decision.blocking.some((item) => item.rule === 'weather.lightning')).toBe(true);
  });

  it('stops a shot fired by somebody with a lapsed certificate', () => {
    walkClearance();
    const lapsed = parseCertificate({ ...certificate, expiresOn: '2025-01-01' });
    const decision = service.gate({ blastId, ...gateInputs(), certificates: [lapsed] });
    expect(decision.blocking.some((item) => item.rule === 'certificate.expired')).toBe(true);
  });

  it('stops a shot outside the permitted hours', () => {
    walkClearance();
    const decision = service.gate({
      blastId,
      ...gateInputs(),
      at: '2025-08-19T20:00:00.000Z',
    });
    expect(decision.blocking.some((item) => item.rule.startsWith('firing.'))).toBe(true);
  });

  it('carries the design side findings through', () => {
    walkClearance();
    const decision = service.gate({
      blastId,
      ...gateInputs(),
      design: { charging: { violations: [{ rule: 'stemming.minimum', message: 'short' }] } },
    });
    expect(decision.blocking.some((item) => item.area === 'charging')).toBe(true);
  });

  it('reports a check nobody ran', () => {
    walkClearance();
    const decision = service.gate({ blastId, ...gateInputs(), observation: undefined });
    expect(decision.blocking.some((item) => item.rule === 'gate.check_not_run')).toBe(true);
  });
});

describe('fire', () => {
  it('fires a shot that passes the gate', () => {
    walkClearance();
    const result = service.fire({ blastId, shotfirerId: 'per_1', gateInputs: gateInputs() });
    expect(result.blast.state).toBe('fired');
    expect(result.blast.firedAt).toBe(noon);
  });

  it('refuses a shot that does not', () => {
    service.startClearance({ blastId });
    expect(() => service.fire({ blastId, shotfirerId: 'per_1', gateInputs: gateInputs() })).toThrow(
      RuleViolationError,
    );
  });

  it('leaves the shot untouched when it refuses', () => {
    service.startClearance({ blastId });
    try {
      service.fire({ blastId, shotfirerId: 'per_1', gateInputs: gateInputs() });
    } catch {
      // expected
    }
    expect(getBlast(db, blastId).state).toBe('tied_in');
  });

  it('refuses a shot with no named shotfirer', () => {
    walkClearance();
    expect(() => service.fire({ blastId, gateInputs: gateInputs() })).toThrow(ValidationError);
  });
});

describe('misfires', () => {
  it('records a misfire and then makes it safe', () => {
    walkClearance();
    service.fire({ blastId, shotfirerId: 'per_1', gateInputs: gateInputs() });
    const misfired = service.reportMisfire({
      blastId,
      reason: 'row three did not go',
      actorId: 'per_1',
    });
    expect(misfired.blast.state).toBe('misfired');
    const safe = service.makeSafe({
      blastId,
      shotfirerId: 'per_1',
      note: 'washed out and reprimed',
    });
    expect(safe.blast.state).toBe('made_safe');
  });

  it('refuses a misfire with nothing written down', () => {
    walkClearance();
    service.fire({ blastId, shotfirerId: 'per_1', gateInputs: gateInputs() });
    expect(() => service.reportMisfire({ blastId, reason: 'x' })).toThrow(ValidationError);
  });
});
