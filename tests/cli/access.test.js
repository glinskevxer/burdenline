import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase, seedPerson } from '../helpers/database.js';
import { buildCommands } from '../../src/cli/commands/index.js';
import { run, EXIT } from '../../src/cli/framework.js';
import { insertRow } from '../../src/db/repository.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';

let db;
let commands;
const clock = fixedClock('2026-06-18T09:00:00Z');

function collector() {
  const out = [];
  const err = [];
  return {
    io: { log: (line) => out.push(String(line)), error: (line) => err.push(String(line)) },
    out,
    err,
  };
}

function certificate(personId, expiresOn, extra = {}) {
  insertRow(db, 'certificate', {
    id: `cert_${personId}_${expiresOn}`,
    personId,
    kind: 'shotfirer',
    issuedOn: '2023-01-01',
    expiresOn,
    endorsements: 'bulk_explosive',
    createdAt: clock.now(),
    updatedAt: clock.now(),
    ...extra,
  });
}

beforeEach(async () => {
  db = await openTestDatabase();
  commands = buildCommands({ db, clock, logger: silentLogger() });
  seedPerson(db, { id: 'per_1', name: 'M Cronin', roles: 'shotfirer' });
  seedPerson(db, { id: 'per_2', name: 'J Ryan', roles: 'manager' });
  seedPerson(db, { id: 'per_3', name: 'Old Hand', roles: 'shotfirer', active: 0 });
});

afterEach(() => closeTestDatabase(db));

describe('people', () => {
  it('lists everybody with their roles', async () => {
    const { io, out } = collector();
    expect(await run(commands, ['people'], io)).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('M Cronin');
    expect(out.join('\n')).toContain('inactive');
    expect(out.at(-1)).toBe('3 people');
  });

  it('writes json when asked', async () => {
    const { io, out } = collector();
    await run(commands, ['people', '--format', 'json'], io);
    const people = JSON.parse(out[0]);
    expect(people.find((person) => person.id === 'per_2').grants).toContain('approve');
  });
});

describe('whoami', () => {
  it('says what a certified shotfirer may do', async () => {
    certificate('per_1', '2029-01-01');
    const { io, out } = collector();
    expect(await run(commands, ['whoami', '--person', 'per_1'], io)).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('may: clearance, fire, read');
    expect(out.join('\n')).toContain('could fire a shot today');
  });

  it('takes a name as well as an id', async () => {
    certificate('per_1', '2029-01-01');
    const { io, out } = collector();
    await run(commands, ['whoami', '--person', 'm cronin'], io);
    expect(out[0]).toContain('M Cronin');
  });

  it('says why somebody could not fire today', async () => {
    certificate('per_1', '2025-01-01');
    const { io, err } = collector();
    expect(await run(commands, ['whoami', '--person', 'per_1'], io)).toBe(EXIT.refused);
    expect(err.join('\n')).toContain('certificate.expired');
  });

  it('refuses somebody who is not a shotfirer at all', async () => {
    const { io, err } = collector();
    expect(await run(commands, ['whoami', '--person', 'per_2'], io)).toBe(EXIT.refused);
    expect(err.join('\n')).toContain('person.not_a_shotfirer');
  });

  it('answers not found for somebody who is not on the books', async () => {
    const { io, err } = collector();
    expect(await run(commands, ['whoami', '--person', 'per_99'], io)).toBe(EXIT.notFound);
    expect(err[0]).toContain('nobody called per_99');
  });

  it('needs a person', async () => {
    const { io, err } = collector();
    expect(await run(commands, ['whoami'], io)).toBe(EXIT.usage);
    expect(err[0]).toContain('--person');
  });
});

describe('version', () => {
  it('prints the package version and the schema the database is at', async () => {
    const { io, out } = collector();
    expect(await run(commands, ['version'], io)).toBe(EXIT.ok);
    expect(out[0]).toContain('burdenline');
    expect(out[1]).toMatch(/^schema \d{3}$/);
    expect(out[2]).toContain('node v');
  });
});
