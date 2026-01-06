/**
 * Sites and benches.
 *
 * A repository here is a set of functions over an open database rather than a
 * class holding one, because everything in this system is synchronous and a
 * transaction is a plain function call. Timestamps are set here and nowhere
 * else, so a caller cannot forget one and nothing has to trust a clock coming in
 * over HTTP.
 */

import { pick } from '../../lib/guards.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import {
  findById,
  getById,
  listWhere,
  countWhere,
  deleteRow,
  createRecord,
  updateRecord,
} from '../repository.js';

export function createSite(db, input, { clock }) {
  return createRecord(
    db,
    {
      table: 'site',
      prefix: 'site',
      defaults: { timeZone: 'UTC', licenceNumber: null, gridEpsg: null },
    },
    pick(input, ['id', 'code', 'name', 'timeZone', 'licenceNumber', 'gridEpsg']),
    { clock },
  );
}

export function findSite(db, id) {
  return findById(db, 'site', id);
}

export function getSite(db, id) {
  return getById(db, 'site', id, { kind: 'site' });
}

export function findSiteByCode(db, code) {
  const [found] = listWhere(db, 'site', { code }, { pageSize: 1 });
  return found ?? null;
}

export function listSites(db, options = {}) {
  return listWhere(db, 'site', {}, { orderBy: 'code', ...options });
}

export function updateSite(db, id, changes, { clock }) {
  return updateRecord(
    db,
    { table: 'site', kind: 'site', updatable: ['name', 'timeZone', 'licenceNumber', 'gridEpsg'] },
    id,
    changes,
    { clock },
  );
}

export function createBench(db, input, { clock }) {
  getSite(db, input.siteId);
  return createRecord(
    db,
    { table: 'bench', prefix: 'bench', defaults: { ucsMpa: null, status: 'active' } },
    pick(input, [
      'id',
      'siteId',
      'name',
      'crestLevelM',
      'toeLevelM',
      'rockType',
      'rockDensityKgM3',
      'ucsMpa',
      'status',
    ]),
    { clock },
  );
}

export function getBench(db, id) {
  return getById(db, 'bench', id, { kind: 'bench' });
}

export function listBenches(db, siteId, options = {}) {
  return listWhere(
    db,
    'bench',
    { siteId, status: options.status },
    { orderBy: 'name', ...options },
  );
}

export function updateBench(db, id, changes, { clock }) {
  return updateRecord(
    db,
    {
      table: 'bench',
      kind: 'bench',
      updatable: [
        'name',
        'crestLevelM',
        'toeLevelM',
        'rockType',
        'rockDensityKgM3',
        'ucsMpa',
        'status',
      ],
    },
    id,
    changes,
    { clock },
  );
}

/** Bench height, which is the number every design starts from. */
export function benchHeightM(bench) {
  return Number((bench.crestLevelM - bench.toeLevelM).toFixed(3));
}

export function retireBench(db, id, { clock }) {
  const bench = getBench(db, id);
  if (bench.status === 'worked_out') {
    throw new ConflictError('that bench is already worked out', { benchId: id });
  }
  return updateBench(db, id, { status: 'worked_out' }, { clock });
}

/**
 * A site is only deleted when nothing was ever recorded against it, which in
 * practice means a site created by mistake. Anything else is closed, not
 * deleted, because the day-book and the monitor records refer to it.
 */
export function deleteSite(db, id) {
  getSite(db, id);
  if (countWhere(db, 'blast', { siteId: id }) > 0) {
    throw new ConflictError('that site has shots recorded against it', { siteId: id });
  }
  const removed = deleteRow(db, 'site', id);
  if (removed === 0) {
    throw new NotFoundError('site', id);
  }
  return removed;
}
