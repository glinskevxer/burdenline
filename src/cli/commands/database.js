/**
 * The commands that touch the database directly: migrate, seed and status.
 *
 * `seed` refuses to run against a database that already has a site in it unless
 * it is told to, because the demonstration data is written with fixed
 * identifiers and running it twice against a real site is not something to find
 * out about afterwards.
 */

import { migrateToLatest, appliedMigrations, schemaVersion } from '../../db/migrate.js';
import { integrityCheck } from '../../db/connection.js';
import { countWhere } from '../../db/repository.js';
import { seedDemoSite } from '../../fixtures/demo-site.js';
import { EXIT, UsageError } from '../framework.js';

export function databaseCommands({ db, clock }) {
  return {
    migrate: {
      summary: 'apply any migrations the database has not had yet',
      options: { 'dry-run': 'list what would run and change nothing' },
      async run({ options, io }) {
        if (options.dryRun) {
          const applied = appliedMigrations(db).map((row) => row.id);
          io.log(`applied so far: ${applied.join(', ') || 'none'}`);
          return EXIT.ok;
        }
        const result = await migrateToLatest(db);
        io.log(
          result.applied.length === 0
            ? `nothing to do, the database is at ${schemaVersion(db)}`
            : `applied ${result.applied.join(', ')}`,
        );
        return EXIT.ok;
      },
    },

    status: {
      summary: 'say what version the database is at and whether it is healthy',
      async run({ io }) {
        const version = schemaVersion(db);
        const health = integrityCheck(db);
        io.log(`schema version: ${version ?? 'none'}`);
        io.log(`integrity: ${health.ok ? 'ok' : health.report.join('; ')}`);
        for (const table of ['site', 'bench', 'pattern', 'hole', 'blast', 'monitor_record']) {
          io.log(`${table}: ${countWhere(db, table)}`);
        }
        return health.ok ? EXIT.ok : EXIT.failed;
      },
    },

    seed: {
      summary: 'load a demonstration quarry to try things against',
      usage: '--code MDW [--force]',
      options: {
        code: 'the site code to create, two to four capitals',
        force: 'load it even though the database already has a site in it',
      },
      async run({ options, io }) {
        const code = options.code ?? 'MDW';
        if (!/^[A-Z]{2,4}$/.test(code)) {
          throw new UsageError('--code is two to four capital letters');
        }
        if (countWhere(db, 'site') > 0 && !options.force) {
          io.error('this database already has a site in it, pass --force to seed anyway');
          return EXIT.refused;
        }
        const seeded = seedDemoSite(db, { clock, code });
        io.log(`seeded ${seeded.site.code} with ${seeded.holes.length} holes drilled`);
        io.log(`magazine ${seeded.magazine.name} and ${seeded.receptors.length} receptors`);
        return EXIT.ok;
      },
    },
  };
}
