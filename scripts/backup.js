#!/usr/bin/env node
/**
 * Back the database up.
 *
 * SQLite's own backup api takes a consistent copy of a database that is being
 * written to, which is the whole point: copying the file with cp while the
 * server is running gives you a file that may or may not open. The copy is
 * verified before it is kept, because an unverified backup is a guess.
 */

import { mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { parseArgv } from '../src/cli/framework.js';

const { options } = parseArgv(['backup', ...process.argv.slice(2)]);
const source = options.db ?? process.env.BURDENLINE_DB ?? 'data/burdenline.db';
const outDirectory = options.out ?? 'backups';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = join(outDirectory, `burdenline-${stamp}.db`);
const partial = `${target}.partial`;

mkdirSync(outDirectory, { recursive: true });

const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(partial);
} finally {
  db.close();
}

const check = new Database(partial, { readonly: true, fileMustExist: true });
try {
  const result = check.pragma('integrity_check', { simple: true });
  if (result !== 'ok') {
    throw new Error(`the copy did not verify: ${result}`);
  }
  const tables = check
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
    .get().n;
  if (tables === 0) {
    throw new Error('the copy has no tables in it');
  }
} catch (error) {
  check.close();
  unlinkSync(partial);
  console.error(error.message);
  process.exit(1);
}
check.close();

renameSync(partial, target);
console.log(`${target} ${statSync(target).size} bytes`);
