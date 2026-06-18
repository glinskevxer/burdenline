/**
 * The commands about who is who.
 *
 * `token` exists because the api needs one and a person on a bench with a
 * terminal should not have to post json to get it. `whoami` reads one back,
 * which is the fastest way to find out why a call is being refused: nine times
 * out of ten the answer is that the token was signed for a different site.
 */

import { readFileSync } from 'node:fs';
import { rowsToObjects } from '../../db/repository.js';
import { grantsFor, ROLES } from '../../http/plugins/auth.js';
import { heldBy, mayFire } from '../../domain/people/competency.js';
import { EXIT, UsageError, required } from '../framework.js';

export function accessCommands({ db, clock }) {
  function personBy(idOrName) {
    const rows = rowsToObjects(
      db
        .prepare('SELECT * FROM person WHERE id = ? OR lower(name) = lower(?) ORDER BY id')
        .all(idOrName, idOrName),
    );
    return rows[0] ?? null;
  }

  function rolesOf(person) {
    return String(person.roles)
      .split(',')
      .map((role) => role.trim())
      .filter((role) => ROLES.includes(role));
  }

  return {
    people: {
      summary: 'list who is on the books and what they are allowed to do',
      options: { format: 'text or json' },
      async run({ options, io }) {
        const people = rowsToObjects(db.prepare('SELECT * FROM person ORDER BY name').all()).map(
          (person) => ({
            id: person.id,
            name: person.name,
            active: person.active === 1,
            roles: rolesOf(person),
            grants: grantsFor(rolesOf(person)),
            certificates: heldBy(person.id, certificates(db), clock.date()).length,
          }),
        );
        if (options.format === 'json') {
          io.log(JSON.stringify(people, null, 2));
          return EXIT.ok;
        }
        for (const person of people) {
          io.log(
            `${person.name.padEnd(20)} ${person.active ? 'active  ' : 'inactive'} ${person.roles.join(', ') || 'no role'}`,
          );
        }
        io.log(`${people.length} people`);
        return EXIT.ok;
      },
    },

    whoami: {
      summary: 'say what a person may do and whether they could fire a shot today',
      usage: '--person per_1',
      options: { person: 'the person id or their name' },
      async run({ options, io }) {
        required(options, ['person']);
        const person = personBy(options.person);
        if (!person) {
          io.error(`there is nobody called ${options.person}`);
          return EXIT.notFound;
        }
        const roles = rolesOf(person);
        io.log(`${person.name} (${person.id})`);
        io.log(`roles: ${roles.join(', ') || 'none'}`);
        io.log(`may: ${grantsFor(roles).join(', ') || 'nothing'}`);
        const held = heldBy(person.id, certificates(db), clock.date());
        for (const certificate of held) {
          io.log(
            `  ${certificate.kind} ${certificate.current ? 'current' : 'NOT CURRENT'} to ${certificate.expiresOn}`,
          );
        }
        const firing = mayFire({
          person: {
            id: person.id,
            name: person.name,
            roles: roles.length > 0 ? roles : ['viewer'],
            active: person.active === 1,
          },
          certificates: held,
          onDate: clock.date(),
        });
        if (firing.valid) {
          io.log('could fire a shot today');
          return EXIT.ok;
        }
        for (const violation of firing.violations) {
          io.error(`  ${violation.rule}: ${violation.message}`);
        }
        return EXIT.refused;
      },
    },

    version: {
      summary: 'print the version and the schema this build expects',
      async run({ io }) {
        const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
        const schema = db.prepare('SELECT max(id) AS id FROM schema_migration').get()?.id ?? 'none';
        io.log(`${name} ${version}`);
        io.log(`schema ${schema}`);
        io.log(`node ${process.version}`);
        return EXIT.ok;
      },
    },
  };
}

function certificates(db) {
  return rowsToObjects(db.prepare('SELECT * FROM certificate').all()).map((row) => ({
    ...row,
    endorsements: row.endorsements ? String(row.endorsements).split(',').filter(Boolean) : [],
    suspended: row.suspended === 1,
  }));
}

export function assertPersonNamed(options) {
  if (!options.person) {
    throw new UsageError('name the person with --person');
  }
  return options.person;
}
