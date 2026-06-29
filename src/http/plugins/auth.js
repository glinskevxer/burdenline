/**
 * Who is asking.
 *
 * Tokens are signed here and verified here, and the only thing the rest of the
 * application sees is `request.actor`: an id, a name and a set of roles. Roles
 * are coarse on purpose. Fine grained permissions on a system with fifteen users
 * are a way of making it possible to lock the quarry manager out of the day-book
 * at four in the morning, which is worse than the problem they solve.
 *
 * A token carries the site it was issued for. Somebody with an account on one
 * quarry has no business reading another one, and that is checked on the token
 * rather than on every query, because a query written next year will forget.
 */

import jwt from '@fastify/jwt';
import { AuthenticationError, AuthorizationError } from '../../lib/errors.js';

export const ROLES = ['viewer', 'designer', 'shotfirer', 'store', 'manager', 'admin'];

/** What each role may do, expanded so a route can name one thing. */
export const GRANTS = Object.freeze({
  viewer: ['read'],
  designer: ['read', 'design'],
  shotfirer: ['read', 'fire', 'clearance'],
  store: ['read', 'magazine'],
  manager: ['read', 'design', 'approve', 'fire', 'clearance', 'magazine', 'monitoring'],
  admin: ['read', 'design', 'approve', 'fire', 'clearance', 'magazine', 'monitoring', 'administer'],
});

export function grantsFor(roles = []) {
  const grants = new Set();
  for (const role of roles) {
    for (const grant of GRANTS[role] ?? []) {
      grants.add(grant);
    }
  }
  return [...grants].sort();
}

export async function registerAuth(app, { config }) {
  await app.register(jwt, {
    secret: config.auth.jwtSecret,
    sign: { expiresIn: `${config.auth.tokenTtlMinutes}m` },
  });

  app.decorate('authenticate', async function authenticate(request) {
    try {
      await request.jwtVerify();
    } catch (cause) {
      // The library has changed the code on this twice, so the message is read
      // as well. Telling somebody their token has expired is the difference
      // between them signing in again and ringing the office.
      const expired =
        cause?.code === 'FAST_JWT_EXPIRED' ||
        cause?.code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED' ||
        /expired/i.test(cause?.message ?? '');
      throw new AuthenticationError(expired ? 'that token has expired' : 'not authenticated');
    }
    const payload = request.user ?? {};
    request.actor = {
      id: payload.sub,
      name: payload.name ?? null,
      roles: payload.roles ?? [],
      siteId: payload.siteId ?? null,
      grants: grantsFor(payload.roles ?? []),
    };
  });

  app.decorate('requireGrant', function requireGrant(grant) {
    return async function check(request) {
      await app.authenticate(request);
      if (!request.actor.grants.includes(grant)) {
        throw new AuthorizationError(`this needs the ${grant} permission`, {
          needed: grant,
          held: request.actor.grants,
        });
      }
    };
  });

  app.decorate('requireSite', function requireSite(getSiteId) {
    return async function check(request) {
      await app.authenticate(request);
      const siteId = getSiteId(request);
      if (request.actor.siteId && siteId && request.actor.siteId !== siteId) {
        throw new AuthorizationError('that is a different site', {
          held: request.actor.siteId,
          asked: siteId,
        });
      }
    };
  });

  return app;
}

/** Issue a token. Used by the sign in route and by the command line tool. */
export function issueToken(app, { id, name, roles, siteId = null }) {
  if (!id) {
    throw new AuthenticationError('a token needs somebody to be about');
  }
  const unknown = roles.filter((role) => !ROLES.includes(role));
  if (unknown.length > 0) {
    throw new AuthorizationError(`unknown role ${unknown.join(', ')}`, { roles: unknown });
  }
  return app.jwt.sign({ sub: id, name, roles, siteId });
}

export function authRoutes(app) {
  app.post(
    '/auth/token',
    {
      schema: {
        body: {
          type: 'object',
          required: ['personId'],
          additionalProperties: false,
          properties: {
            personId: { type: 'string', minLength: 1, maxLength: 40 },
            siteId: { type: 'string', maxLength: 40 },
          },
        },
      },
    },
    async (request) => {
      const { db } = app.deps;
      const person = db
        .prepare('SELECT id, name, roles, active FROM person WHERE id = ?')
        .get(request.body.personId);
      if (!person || person.active !== 1) {
        throw new AuthenticationError('that person cannot sign in');
      }
      const roles = String(person.roles)
        .split(',')
        .map((role) => role.trim())
        .filter((role) => ROLES.includes(role));
      return {
        token: issueToken(app, {
          id: person.id,
          name: person.name,
          roles: roles.length > 0 ? roles : ['viewer'],
          siteId: request.body.siteId ?? null,
        }),
        expiresInMinutes: app.deps.config.auth.tokenTtlMinutes,
        roles,
      };
    },
  );

  app.get('/auth/whoami', { preHandler: app.authenticate }, async (request) => request.actor);
  return app;
}
