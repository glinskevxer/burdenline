/**
 * The thin layer every repository is built on.
 *
 * There is no ORM here on purpose. What the repositories share is the boring
 * part: turning snake_case columns into camelCase fields, building an insert
 * from an object, and paging a list without letting a caller ask for a hundred
 * thousand rows. Anything that needs a join writes the SQL out.
 */

import { NotFoundError, ConflictError, AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

export function toCamel(name) {
  return String(name).replace(/_([a-z0-9])/g, (_match, character) => character.toUpperCase());
}

export function toSnake(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

export function rowToObject(row) {
  if (row === undefined || row === null) {
    return null;
  }
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[toCamel(key)] = value;
  }
  return out;
}

export function rowsToObjects(rows) {
  return rows.map((row) => rowToObject(row));
}

export function objectToRow(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) {
      continue;
    }
    out[toSnake(key)] = value;
  }
  return out;
}

export function insertRow(db, table, object) {
  const row = objectToRow(object);
  const columns = Object.keys(row);
  if (columns.length === 0) {
    throw new AppError(`nothing to insert into ${table}`, { code: 'empty_insert', status: 500 });
  }
  const statement = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns
    .map((column) => `@${column}`)
    .join(', ')})`;
  try {
    db.prepare(statement).run(row);
  } catch (cause) {
    throw translate(cause, table, row);
  }
  return object;
}

export function updateRow(db, table, id, changes, { idColumn = 'id' } = {}) {
  const row = objectToRow(changes);
  const columns = Object.keys(row).filter((column) => column !== idColumn);
  if (columns.length === 0) {
    return 0;
  }
  const assignments = columns.map((column) => `${column} = @${column}`).join(', ');
  const statement = `UPDATE ${table} SET ${assignments} WHERE ${idColumn} = @__id`;
  try {
    return db.prepare(statement).run({ ...row, __id: id }).changes;
  } catch (cause) {
    throw translate(cause, table, row);
  }
}

export function deleteRow(db, table, id, { idColumn = 'id' } = {}) {
  return db.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`).run(id).changes;
}

export function findById(db, table, id, { idColumn = 'id' } = {}) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ?`).get(id);
  return rowToObject(row);
}

export function getById(db, table, id, options = {}) {
  const found = findById(db, table, id, options);
  if (!found) {
    throw new NotFoundError(options.kind ?? table, id);
  }
  return found;
}

export function countWhere(db, table, where = {}) {
  const { clause, parameters } = buildWhere(where);
  return db.prepare(`SELECT count(*) AS n FROM ${table} ${clause}`).get(parameters).n;
}

export function listWhere(db, table, where = {}, options = {}) {
  const { clause, parameters } = buildWhere(where);
  const order = options.orderBy ? `ORDER BY ${options.orderBy}` : '';
  const { limit, offset } = pageBounds(options);
  const rows = db
    .prepare(`SELECT * FROM ${table} ${clause} ${order} LIMIT @__limit OFFSET @__offset`)
    .all({ ...parameters, __limit: limit, __offset: offset });
  return rowsToObjects(rows);
}

export function pageBounds({ page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const index = Math.max(Number(page) || 1, 1);
  return { limit: size, offset: (index - 1) * size, page: index, pageSize: size };
}

export function buildWhere(where = {}) {
  const entries = Object.entries(where).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return { clause: '', parameters: {} };
  }
  const parameters = {};
  const parts = entries.map(([field, value]) => {
    const column = toSnake(field);
    if (value === null) {
      return `${column} IS NULL`;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return '0 = 1';
      }
      const names = value.map((item, index) => {
        parameters[`${column}_${index}`] = item;
        return `@${column}_${index}`;
      });
      return `${column} IN (${names.join(', ')})`;
    }
    parameters[column] = value;
    return `${column} = @${column}`;
  });
  return { clause: `WHERE ${parts.join(' AND ')}`, parameters };
}

function translate(cause, table, row) {
  const message = String(cause?.message ?? '');
  if (message.includes('UNIQUE constraint failed')) {
    return new ConflictError(`that ${table} already exists`, {
      table,
      constraint: message.split(':').pop()?.trim() ?? null,
    });
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return new ConflictError(`a reference on the ${table} points at nothing`, { table });
  }
  if (message.includes('CHECK constraint failed')) {
    return new ConflictError(`the ${table} row breaks a database rule`, {
      table,
      constraint: message.split(':').pop()?.trim() ?? null,
      keys: Object.keys(row),
    });
  }
  return cause;
}

/**
 * Create and update, with the identifier and the timestamps applied in one
 * place. Six repositories had written this out for themselves and three of them
 * had drifted: two set `updatedAt` on create and one did not, so a freshly
 * created record sorted differently from an edited one depending which table it
 * was in.
 */
export function createRecord(db, { table, prefix, defaults = {} }, fields, { clock }) {
  const now = clock.now();
  const record = {
    id: fields.id ?? newId(prefix),
    ...defaults,
    ...stripUndefined(fields),
    createdAt: now,
    updatedAt: now,
  };
  insertRow(db, table, record);
  return record;
}

export function updateRecord(db, { table, kind, updatable }, id, changes, { clock }) {
  getById(db, table, id, { kind: kind ?? table });
  const allowed = {};
  for (const key of updatable) {
    if (changes[key] !== undefined) {
      allowed[key] = changes[key];
    }
  }
  if (Object.keys(allowed).length === 0) {
    return getById(db, table, id, { kind: kind ?? table });
  }
  updateRow(db, table, id, { ...allowed, updatedAt: clock.now() });
  return getById(db, table, id, { kind: kind ?? table });
}

function stripUndefined(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export const paging = { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE };
