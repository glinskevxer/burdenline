/**
 * The filtered list query, written once.
 *
 * Seven repositories had grown the same shape by hand: a table, an owner column,
 * an optional date range, an optional extra filter, an order and a limit. Each
 * one wrote its own sql with the same `(@from IS NULL OR column >= @from)`
 * trick, and two of them had the comparison the wrong way round on the upper
 * bound so a range that ended on a date excluded that date in one screen and
 * included it in another.
 */

import { toSnake, rowsToObjects } from './repository.js';

const MAX_LIMIT = 2000;

export function buildSelect({
  table,
  columns = '*',
  join = null,
  where = {},
  between = null,
  orderBy = null,
  limit,
}) {
  const parameters = {};
  const clauses = [];

  for (const [field, value] of Object.entries(where)) {
    if (value === undefined) {
      continue;
    }
    const column = qualify(table, toSnake(field), join);
    if (value === null) {
      clauses.push(`${column} IS NULL`);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        clauses.push('0 = 1');
        continue;
      }
      const names = value.map((item, index) => {
        parameters[`${toSnake(field)}_${index}`] = item;
        return `@${toSnake(field)}_${index}`;
      });
      clauses.push(`${column} IN (${names.join(', ')})`);
      continue;
    }
    parameters[toSnake(field)] = value;
    clauses.push(`${column} = @${toSnake(field)}`);
  }

  if (between) {
    const column = qualify(table, toSnake(between.column), join);
    parameters.range_from = between.from ?? null;
    parameters.range_to = between.to ?? null;
    // Both ends are inclusive, everywhere. A period that runs to the last day of
    // the month has to include that day.
    clauses.push('(@range_from IS NULL OR ' + column + ' >= @range_from)');
    clauses.push('(@range_to IS NULL OR ' + column + ' <= @range_to)');
  }

  parameters.limit = Math.min(Math.max(Number(limit) || 200, 1), MAX_LIMIT);
  const sql = [
    `SELECT ${columns} FROM ${table}`,
    join ? join.sql : '',
    clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    orderBy ? `ORDER BY ${orderBy}` : '',
    'LIMIT @limit',
  ]
    .filter(Boolean)
    .join(' ');
  return { sql, parameters };
}

export function selectWhere(db, options) {
  const { sql, parameters } = buildSelect(options);
  return rowsToObjects(db.prepare(sql).all(parameters));
}

function qualify(table, column, join) {
  return join ? `${join.alias ?? table}.${column}` : column;
}

export const queryLimits = { MAX_LIMIT };
