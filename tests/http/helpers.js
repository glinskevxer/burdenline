import { buildApp } from '../../src/http/app.js';
import { closeTestDatabase, openTestDatabase } from '../helpers/database.js';
import { insertRow } from '../../src/db/repository.js';
import { loadConfig } from '../../src/config/env.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';
import { issueToken } from '../../src/http/plugins/auth.js';

export const testConfig = loadConfig({ NODE_ENV: 'test', BURDENLINE_JWT_SECRET: 'd'.repeat(40) });

export async function standUp({ at = '2025-09-17T09:00:00Z' } = {}) {
  const db = await openTestDatabase();
  const clock = fixedClock(at);
  const app = await buildApp({ config: testConfig, db, clock, logger: silentLogger() });
  const people = {
    manager: 'per_manager',
    designer: 'per_designer',
    shotfirer: 'per_shotfirer',
    admin: 'per_admin',
    store: 'per_store',
    viewer: 'per_viewer',
  };
  for (const [role, id] of Object.entries(people)) {
    insertRow(db, 'person', {
      id,
      name: role,
      roles: role,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
  }
  const tokens = Object.fromEntries(
    Object.entries(people).map(([role, id]) => [
      role,
      issueToken(app, { id, name: role, roles: [role] }),
    ]),
  );
  return {
    app,
    db,
    clock,
    tokens,
    people,
    as(role) {
      return { authorization: `Bearer ${tokens[role]}` };
    },
    async close() {
      await app.close();
      closeTestDatabase(db);
    },
  };
}
