/**
 * Prepared statement caching.
 *
 * better-sqlite3 compiles a statement every time `prepare` is called, and the
 * hot paths here call it inside loops: the ledger read runs on every stock
 * check, and the stock check runs on every movement. Caching the compiled
 * statement per connection took the magazine issue path from about eleven
 * milliseconds to under two on a store with four thousand ledger lines.
 *
 * The cache is per connection and it is keyed on the sql text, because a
 * statement compiled against one database cannot be run against another. Closing
 * the connection drops the cache with it.
 */

const caches = new WeakMap();

export function cacheFor(db) {
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  return cache;
}

/** Compile once, reuse after. The sql text is the key, so keep it constant. */
export function prepared(db, sql) {
  const cache = cacheFor(db);
  const existing = cache.get(sql);
  if (existing) {
    return existing;
  }
  const statement = db.prepare(sql);
  cache.set(sql, statement);
  return statement;
}

export function cacheSize(db) {
  return cacheFor(db).size;
}

export function clearCache(db) {
  cacheFor(db).clear();
}

/**
 * A tiny helper for the reads that happen constantly. Anything with a shape that
 * varies by call keeps writing its own sql; this is for the ones that do not.
 */
export function queries(db) {
  return {
    ledgerFor(magazineId) {
      return prepared(
        db,
        `SELECT l.*, b.batch_code, p.code AS product_code, p.kind AS product_kind
         FROM magazine_ledger l
         JOIN product_batch b ON b.id = l.batch_id
         JOIN product p ON p.id = b.product_id
         WHERE l.magazine_id = ?
         ORDER BY l.occurred_at, l.id`,
      ).all(magazineId);
    },
    holesFor(patternId) {
      return prepared(db, 'SELECT * FROM hole WHERE pattern_id = ? ORDER BY hole_number').all(
        patternId,
      );
    },
    blastById(id) {
      return prepared(db, 'SELECT * FROM blast WHERE id = ?').get(id);
    },
    receptorsFor(siteId) {
      return prepared(db, 'SELECT * FROM receptor WHERE site_id = ? ORDER BY name').all(siteId);
    },
    countOf(table) {
      return prepared(db, `SELECT count(*) AS n FROM ${table}`).get().n;
    },
  };
}
