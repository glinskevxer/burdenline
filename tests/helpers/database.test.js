import { describe, it, expect, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase, migrations, seedPerson } from './database.js';
import { schemaVersion } from '../../src/db/migrate.js';
import { findById } from '../../src/db/repository.js';

const opened = [];

async function open() {
  const db = await openTestDatabase();
  opened.push(db);
  return db;
}

afterEach(() => {
  while (opened.length) {
    closeTestDatabase(opened.pop());
  }
});

describe('the test database helper', () => {
  it('gives back a database at the latest schema', async () => {
    expect(schemaVersion(await open())).toBe((await migrations()).at(-1).id);
  });

  it('loads the migrations the application ships rather than a list of its own', async () => {
    const list = await migrations();
    expect(list.map((migration) => migration.id)).toEqual(['001', '002', '003', '004', '005']);
  });

  it('reads the migration directory only once', async () => {
    expect(await migrations()).toBe(await migrations());
  });

  it('gives each test its own database', async () => {
    const first = await open();
    const second = await open();
    seedPerson(first);
    expect(findById(second, 'person', 'per_1')).toBe(null);
  });

  it('seeds a person to hang foreign keys off', async () => {
    const db = await open();
    seedPerson(db, { id: 'per_9', name: 'J Ryan', roles: 'manager' });
    expect(findById(db, 'person', 'per_9').name).toBe('J Ryan');
  });

  it('closes cleanly and tolerates being closed twice', async () => {
    const db = await openTestDatabase();
    closeTestDatabase(db);
    expect(db.open).toBe(false);
    expect(() => closeTestDatabase(db)).not.toThrow();
  });
});
