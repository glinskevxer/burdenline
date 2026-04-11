/**
 * Making a repeated write safe.
 *
 * The failure this exists for is specific. A shotfirer on a phone at the top of
 * a bench presses issue, the signal drops before the response comes back, and
 * they press it again. Without this, four hundred kilograms leaves the magazine
 * twice.
 *
 * A client sends an idempotency key with a write. The first request runs and its
 * response is remembered against that key; a second request with the same key
 * gets the first response back rather than running again. A second request with
 * the same key and a different body is refused outright, because that is a
 * client bug and replaying the first answer would hide it.
 */

import { createHash } from 'node:crypto';
import { ConflictError } from '../../lib/errors.js';

const HEADER = 'idempotency-key';
const METHODS = ['POST', 'PUT', 'PATCH'];

export function fingerprint(request) {
  return createHash('sha256')
    .update(request.method)
    .update('\n')
    .update(request.url)
    .update('\n')
    .update(JSON.stringify(request.body ?? null))
    .digest('hex')
    .slice(0, 32);
}

export function createStore({ ttlMs = 24 * 60 * 60 * 1000, maximum = 5000 } = {}) {
  const entries = new Map();

  function prune(now) {
    for (const [key, entry] of entries) {
      if (now - entry.at > ttlMs) {
        entries.delete(key);
      }
    }
    while (entries.size > maximum) {
      entries.delete(entries.keys().next().value);
    }
  }

  return {
    get(key, now) {
      const entry = entries.get(key);
      if (!entry) {
        return null;
      }
      if (now - entry.at > ttlMs) {
        entries.delete(key);
        return null;
      }
      return entry;
    },
    remember(key, entry, now) {
      entries.set(key, { ...entry, at: now });
      prune(now);
      return entry;
    },
    size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

export function registerIdempotency(app, { store = createStore(), now = () => Date.now() } = {}) {
  app.decorate('idempotencyStore', store);

  app.addHook('preHandler', async (request, reply) => {
    const key = request.headers[HEADER];
    if (!key || !METHODS.includes(request.method)) {
      return;
    }
    const seen = store.get(String(key), now());
    if (!seen) {
      return;
    }
    if (seen.fingerprint !== fingerprint(request)) {
      throw new ConflictError('that idempotency key was used for a different request', {
        key: String(key),
      });
    }
    reply
      .code(seen.status)
      .header('content-type', 'application/json; charset=utf-8')
      .header('idempotent-replay', 'true')
      .send(seen.body);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const key = request.headers[HEADER];
    if (!key || !METHODS.includes(request.method) || reply.getHeader('idempotent-replay')) {
      return payload;
    }
    if (reply.statusCode >= 400) {
      return payload;
    }
    store.remember(
      String(key),
      { status: reply.statusCode, body: payload, fingerprint: fingerprint(request) },
      now(),
    );
    return payload;
  });

  return app;
}

export const idempotencyHeader = HEADER;
