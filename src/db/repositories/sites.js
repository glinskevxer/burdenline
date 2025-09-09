/**
 * Sites and benches.
 *
 * A repository here is a set of functions over an open database rather than a
 * class holding one, because everything in this system is synchronous and a
 * transaction is a plain function call. Timestamps are set here and nowhere
 * else, so a caller cannot forget one and nothing has to trust a clock coming in
 * over HTTP.
 */

import { newId } from '../../lib/ids.js';
import { pick } from '../../lib/guards.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import {
  insertRow,
  updateRow,
  findById,
  getById,
  listWhere,
  countWhere,
  deleteRow,
} from '../repository.js';

export function createSite(db, input, { clock }) {
  const now = clock.now();
  const site = {
    id: input.id ?? newId('site'),
    code: input.code,
    name: input.name,
    timeZone: input.timeZone ?? 'UTC',
    licenceNumber: input.licenceNumber ?? null,
    gridEpsg: input.gridEpsg ?? null,
    createdAt: now,
    updatedAt: now,
  };
  insertRow(db, 'site', site);
  return site;
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
  getSite(db, id);
  const allowed = pick(changes, ['name', 'timeZone', 'licenceNumber', 'gridEpsg']);
  updateRow(db, 'site', id, { ...allowed, updatedAt: clock.now() });
  return getSite(db, id);
}

export function createBench(db, input, { clock }) {
  getSite(db, input.siteId);
  const now = clock.now();
  const bench = {
    id: input.id ?? newId('bench'),
    siteId: input.siteId,
    name: input.name,
    crestLevelM: input.crestLevelM,
    toeLevelM: input.toeLevelM,
    rockType: input.rockType,
    rockDensityKgM3: input.rockDensityKgM3,
    ucsMpa: input.ucsMpa ?? null,
    status: input.status ?? 'active',
    createdAt: now,
    updatedAt: now,
  };
  insertRow(db, 'bench', bench);
  return bench;
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
  getBench(db, id);
  const allowed = pick(changes, [
    'name',
    'crestLevelM',
    'toeLevelM',
    'rockType',
    'rockDensityKgM3',
    'ucsMpa',
    'status',
  ]);
  updateRow(db, 'bench', id, { ...allowed, updatedAt: clock.now() });
  return getBench(db, id);
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
