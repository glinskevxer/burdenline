import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase, inTransaction } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { migration as production } from '../../src/db/migrations/005_production.js';
import {
  diff,
  isMeaningful,
  recordChange,
  historyFor,
  byActor,
  since,
  audited,
} from '../../src/db/audit.js';
import { createSite, updateSite, getSite } from '../../src/db/repositories/sites.js';
import { fixedClock } from '../../src/lib/clock.js';

let db;
const clock = fixedClock('2025-12-04T09:00:00Z');

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations, production]);
});

afterEach(() => closeDatabase(db));

describe('diff', () => {
  it('keeps only what changed', () => {
    expect(diff({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual({ b: { from: 2, to: 3 } });
  });

  it('records a field that appeared', () => {
    expect(diff({ a: 1 }, { a: 1, b: 3 })).toEqual({ b: { from: null, to: 3 } });
  });

  it('records a field that was cleared', () => {
    expect(diff({ a: 1, b: 2 }, { a: 1, b: null })).toEqual({ b: { from: 2, to: null } });
  });

  it('never records a secret', () => {
    expect(diff({ jwtSecret: 'old' }, { jwtSecret: 'new' })).toEqual({});
  });

  it('reads a change of nothing as nothing', () => {
    expect(diff({ a: 1 }, { a: 1 })).toEqual({});
  });

  it('ignores a timestamp on its own', () => {
    expect(isMeaningful(diff({ updatedAt: 'a' }, { updatedAt: 'b' }))).toBe(false);
    expect(isMeaningful(diff({ updatedAt: 'a', name: 'x' }, { updatedAt: 'b', name: 'y' }))).toBe(
      true,
    );
  });
});

describe('recordChange', () => {
  it('writes an entry with only the changed fields', () => {
    const entry = recordChange(
      db,
      {
        actorId: 'per_1',
        action: 'receptor.update',
        entityKind: 'receptor',
        entityId: 'rec_1',
        before: { id: 'rec_1', name: 'Cottage', limitMmPerSecond: null },
        after: { id: 'rec_1', name: 'Cottage', limitMmPerSecond: 6 },
      },
      { clock },
    );
    expect(entry.changes).toEqual({ limitMmPerSecond: { from: null, to: 6 } });
    expect(JSON.parse(entry.afterJson)).toEqual({ limitMmPerSecond: 6 });
    expect(JSON.parse(entry.beforeJson)).toEqual({ limitMmPerSecond: null });
  });

  it('writes nothing when only a timestamp moved', () => {
    const entry = recordChange(
      db,
      {
        action: 'site.update',
        entityKind: 'site',
        entityId: 'site_1',
        before: { id: 'site_1', updatedAt: 'a' },
        after: { id: 'site_1', updatedAt: 'b' },
      },
      { clock },
    );
    expect(entry).toBe(null);
    expect(db.prepare('SELECT count(*) AS n FROM audit_entry').get().n).toBe(0);
  });

  it('writes anyway when it is told to', () => {
    const entry = recordChange(
      db,
      {
        action: 'blast.fire',
        entityKind: 'blast',
        entityId: 'blast_1',
        before: null,
        after: null,
        force: true,
      },
      { clock },
    );
    expect(entry.action).toBe('blast.fire');
  });

  it('keeps the request that made the change', () => {
    const entry = recordChange(
      db,
      {
        action: 'site.update',
        entityKind: 'site',
        entityId: 'site_1',
        requestId: 'req_9',
        before: { name: 'a' },
        after: { name: 'b' },
      },
      { clock },
    );
    expect(entry.requestId).toBe('req_9');
  });
});

describe('reading the trail', () => {
  function change(entityId, actorId, name) {
    return recordChange(
      db,
      {
        actorId,
        action: 'site.update',
        entityKind: 'site',
        entityId,
        before: { name: 'before' },
        after: { name },
      },
      { clock },
    );
  }

  it('reads the history of one record newest first', () => {
    change('site_1', 'per_1', 'first');
    change('site_1', 'per_2', 'second');
    change('site_2', 'per_1', 'other');
    const history = historyFor(db, 'site', 'site_1');
    expect(history).toHaveLength(2);
    expect(history[0].after.name).toBe('second');
  });

  it('reads everything one person did', () => {
    change('site_1', 'per_1', 'first');
    change('site_2', 'per_2', 'second');
    expect(byActor(db, 'per_1')).toHaveLength(1);
  });

  it('reads everything since a moment', () => {
    change('site_1', 'per_1', 'first');
    expect(since(db, '2025-12-01T00:00:00.000Z')).toHaveLength(1);
    expect(since(db, '2026-01-01T00:00:00.000Z')).toHaveLength(0);
  });

  it('has nothing to say about a record nobody has touched', () => {
    expect(historyFor(db, 'site', 'site_9')).toEqual([]);
  });
});

describe('audited', () => {
  it('writes the change and the trail entry together', () => {
    const site = createSite(db, { code: 'MDW', name: 'Midway' }, { clock });
    const { result, audit } = inTransaction(db, () =>
      audited(
        db,
        { clock, actorId: 'per_1', action: 'site.update', entityKind: 'site' },
        {
          read: () => getSite(db, site.id),
          write: () => updateSite(db, site.id, { name: 'Midway Quarry' }, { clock }),
        },
      ),
    );
    expect(result.name).toBe('Midway Quarry');
    expect(audit.changes.name).toEqual({ from: 'Midway', to: 'Midway Quarry' });
    expect(historyFor(db, 'site', site.id)).toHaveLength(1);
  });

  it('leaves no entry behind when the write fails', () => {
    const site = createSite(db, { code: 'MDW', name: 'Midway' }, { clock });
    expect(() =>
      inTransaction(db, () =>
        audited(
          db,
          { clock, actorId: 'per_1', action: 'site.update', entityKind: 'site' },
          {
            read: () => getSite(db, site.id),
            write: () => {
              throw new Error('the disk filled up');
            },
          },
        ),
      ),
    ).toThrow('the disk filled up');
    expect(historyFor(db, 'site', site.id)).toEqual([]);
  });
});
