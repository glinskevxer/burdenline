import { buildApp } from '../../src/http/app.js';
import { openDatabase, closeDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migration as core } from '../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../src/db/migrations/004_operations.js';
import { insertRow } from '../../src/db/repository.js';
import { loadConfig } from '../../src/config/env.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';
import { issueToken } from '../../src/http/plugins/auth.js';

export const testConfig = loadConfig({ NODE_ENV: 'test', BURDENLINE_JWT_SECRET: 'd'.repeat(40) });

export async function standUp({ at = '2025-09-17T09:00:00Z' } = {}) {
  const db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations]);
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
      closeDatabase(db);
    },
  };
}
