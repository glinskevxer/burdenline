import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase } from '../helpers/database.js';
import { buildSelect, selectWhere, queryLimits } from '../../src/db/query.js';
import { createSite } from '../../src/db/repositories/sites.js';
import {
  createReceptor,
  importRecords,
  listRecords,
} from '../../src/db/repositories/monitoring.js';
import { parseRecord } from '../../src/domain/monitoring/records.js';
import { fixedClock } from '../../src/lib/clock.js';

let db;
const clock = fixedClock('2026-03-25T09:00:00Z');

beforeEach(async () => {
  db = await openTestDatabase();
});

afterEach(() => closeTestDatabase(db));

describe('buildSelect', () => {
  it('writes an equality filter with a named parameter', () => {
    const built = buildSelect({ table: 'blast', where: { siteId: 'site_1' } });
    expect(built.sql).toContain('WHERE site_id = @site_id');
    expect(built.parameters.site_id).toBe('site_1');
  });

  it('leaves an undefined filter out entirely', () => {
    const built = buildSelect({ table: 'blast', where: { siteId: 'site_1', state: undefined } });
    expect(built.sql).not.toContain('state');
  });

  it('writes a null filter as is null', () => {
    expect(buildSelect({ table: 'blast', where: { firedAt: null } }).sql).toContain(
      'fired_at IS NULL',
    );
  });

  it('writes a list filter as an in clause', () => {
    const built = buildSelect({ table: 'blast', where: { state: ['fired', 'closed'] } });
    expect(built.sql).toContain('state IN (@state_0, @state_1)');
    expect(built.parameters.state_1).toBe('closed');
  });

  it('matches nothing for an empty list', () => {
    expect(buildSelect({ table: 'blast', where: { state: [] } }).sql).toContain('0 = 1');
  });

  it('makes both ends of a range inclusive', () => {
    const built = buildSelect({
      table: 'monitor_record',
      between: { column: 'triggeredAt', from: 'a', to: 'b' },
    });
    expect(built.sql).toContain('triggered_at >= @range_from');
    expect(built.sql).toContain('triggered_at <= @range_to');
  });

  it('leaves an open ended range open', () => {
    const built = buildSelect({
      table: 'x',
      between: { column: 'at', from: undefined, to: undefined },
    });
    expect(built.parameters.range_from).toBe(null);
    expect(built.parameters.range_to).toBe(null);
  });

  it('caps a greedy limit and floors a silly one', () => {
    expect(buildSelect({ table: 'x', limit: 1e9 }).parameters.limit).toBe(queryLimits.MAX_LIMIT);
    expect(buildSelect({ table: 'x', limit: 0 }).parameters.limit).toBe(200);
    expect(buildSelect({ table: 'x', limit: 'lots' }).parameters.limit).toBe(200);
  });

  it('takes an order and a column list', () => {
    const built = buildSelect({ table: 'x', columns: 'id, name', orderBy: 'name DESC' });
    expect(built.sql).toContain('SELECT id, name FROM x');
    expect(built.sql).toContain('ORDER BY name DESC');
  });

  it('qualifies the columns when there is a join', () => {
    const built = buildSelect({
      table: 'survey s',
      join: { sql: 'JOIN blast b ON b.id = s.blast_id', alias: 's' },
      where: { blastId: 'blast_1' },
    });
    expect(built.sql).toContain('s.blast_id = @blast_id');
    expect(built.sql).toContain('JOIN blast b');
  });
});

describe('selectWhere', () => {
  it('runs the query and maps the rows', async () => {
    const site = createSite(db, { code: 'MDW', name: 'Midway' }, { clock });
    expect(selectWhere(db, { table: 'site', where: { code: 'MDW' } })[0].name).toBe('Midway');
    expect(selectWhere(db, { table: 'site', where: { id: site.id } })).toHaveLength(1);
  });

  it('comes back empty rather than failing when nothing matches', () => {
    expect(selectWhere(db, { table: 'site', where: { code: 'ZZZ' } })).toEqual([]);
  });
});

describe('the repositories that use it', () => {
  it('reads a record range with both ends included', async () => {
    const site = createSite(db, { code: 'MDW', name: 'Midway' }, { clock });
    const receptor = createReceptor(
      db,
      {
        siteId: site.id,
        name: 'Keeper cottage',
        structureClass: 'dwelling',
        easting: 1,
        northing: 1,
      },
      { clock },
    );
    const record = (triggeredAt) =>
      parseRecord({
        monitorSerial: 'BE-1',
        receptorId: receptor.id,
        triggeredAt,
        longitudinal: { peakMmPerSecond: 1 },
        transverse: { peakMmPerSecond: 2 },
        vertical: { peakMmPerSecond: 1 },
      });
    importRecords(
      db,
      site.id,
      [record('2026-03-01T09:00:00.000Z'), record('2026-03-31T09:00:00.000Z')],
      { clock },
    );
    const inclusive = listRecords(db, site.id, {
      from: '2026-03-01T09:00:00.000Z',
      to: '2026-03-31T09:00:00.000Z',
    });
    expect(inclusive).toHaveLength(2);
  });

  it('reads a null receptor filter as no filter at all', async () => {
    const site = createSite(db, { code: 'MDW', name: 'Midway' }, { clock });
    importRecords(
      db,
      site.id,
      [
        parseRecord({
          monitorSerial: 'BE-1',
          triggeredAt: '2026-03-02T09:00:00.000Z',
          longitudinal: { peakMmPerSecond: 1 },
          transverse: { peakMmPerSecond: 2 },
          vertical: { peakMmPerSecond: 1 },
        }),
      ],
      { clock },
    );
    expect(listRecords(db, site.id, { receptorId: null })).toHaveLength(1);
  });
});
