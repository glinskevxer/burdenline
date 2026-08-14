#!/usr/bin/env node
/**
 * The list somebody walks before this goes on a machine in a quarry office.
 *
 * Every check here has failed at least once in a way that would have shipped:
 * a migration edited after it had been applied, an api description that no
 * longer matched the routes, a script that required a package nobody had
 * declared, and a version in package.json that had not moved since the last
 * release. The point of the script is that walking the list by hand means
 * skipping the boring one, which is always the one that fails.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../src/db/connection.js';
import {
  loadMigrations,
  runMigrations,
  appliedMigrations,
  pendingMigrations,
} from '../src/db/migrate.js';

export function runStep(name, command, args, { optional = false } = {}) {
  const started = Date.now();
  try {
    execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
    return { name, ok: true, ms: Date.now() - started, optional };
  } catch (error) {
    return {
      name,
      ok: false,
      optional,
      ms: Date.now() - started,
      // stdout is empty for a command that only wrote to stderr, and an empty
      // detail on a failed release check is the least useful thing there is.
      detail: [error.stdout, error.stderr, error.message]
        .map((part) => String(part ?? '').trim())
        .filter(Boolean)
        .join('\n')
        .slice(-1200),
    };
  }
}

/** Apply every migration to a fresh database and check none of them has drifted. */
export async function checkMigrations() {
  const db = openDatabase({ database: { file: ':memory:' } });
  try {
    const migrations = await loadMigrations();
    runMigrations(db, migrations);
    const applied = appliedMigrations(db);
    const pending = pendingMigrations(db, migrations);
    return {
      name: 'migrations apply cleanly and none has been edited since',
      ok: pending.length === 0 && applied.length === migrations.length,
      detail: `${applied.length} applied, ${pending.length} pending`,
    };
  } catch (error) {
    return { name: 'migrations apply cleanly', ok: false, detail: error.message };
  } finally {
    closeDatabase(db);
  }
}

/**
 * Which files a script writes, read out of the scripts rather than kept in a
 * list somebody has to remember to update. A target has to be a plain string
 * constant for this to see it, which is the same restriction that makes the
 * scripts readable, so it has not cost anything yet.
 */
export function generatedTargets(sources) {
  const targets = new Set();
  for (const [file, text] of Object.entries(sources)) {
    const constants = new Map();
    for (const [, name, value] of text.matchAll(/const\s+([A-Z_]+)\s*=\s*'([^']+)'/g)) {
      constants.set(name, value);
    }
    for (const [, argument] of text.matchAll(/writeFileSync\(\s*([A-Za-z_'"][^,]*)/g)) {
      const literal = argument.match(/^'([^']+)'$/);
      const named = constants.get(argument.trim());
      const target = literal ? literal[1] : named;
      if (target && !target.startsWith('/') && !target.includes('${')) {
        targets.add(target);
      }
    }
    void file;
  }
  return [...targets].sort();
}

/** The paths `.gitattributes` marks as generated. */
export function markedGenerated(attributesText) {
  return attributesText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && /linguist-generated=true/.test(line))
    .map((line) => line.split(/\s+/)[0])
    .sort();
}

/**
 * Every generated file that git tracks has to be marked.
 *
 * An unmarked one counts toward the repository's language statistics and reads
 * in a review as though somebody typed it. The check is here rather than in a
 * comment because the next person to add a generator will not read the comment.
 */
export function checkGeneratedMarked(sources, attributesText, tracked) {
  const name = 'every generated file that is checked in is marked as generated';
  const trackedSet = new Set(tracked);
  const marked = new Set(markedGenerated(attributesText));
  const missing = generatedTargets(sources).filter(
    (target) => trackedSet.has(target) && !marked.has(target),
  );
  if (!/^\*\s+text=auto\s+eol=lf$/m.test(attributesText)) {
    return { name, ok: false, detail: 'no line ending rule, expected: * text=auto eol=lf' };
  }
  return {
    name,
    ok: missing.length === 0,
    detail: missing.length > 0 ? `not marked: ${missing.join(', ')}` : null,
  };
}

export function checkVersion(packageText, tags) {
  const { version } = JSON.parse(packageText);
  const released = tags
    .split('\n')
    .map((tag) => tag.trim().replace(/^v/, ''))
    .filter(Boolean);
  return {
    name: 'the version has moved since the last tag',
    ok: !released.includes(version),
    detail: released.includes(version) ? `${version} is already tagged` : `releasing ${version}`,
  };
}

export function summarise(results) {
  const failed = results.filter((result) => !result.ok && !result.optional);
  return {
    steps: results.length,
    failed: failed.length,
    ready: failed.length === 0,
    results,
  };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const results = [
    runStep('lint', 'npm', ['run', '--silent', 'lint']),
    runStep('formatting', 'npm', ['run', '--silent', 'format:check']),
    runStep('tests and coverage floors', 'npm', ['run', '--silent', 'coverage']),
    runStep('the api description matches the routes', 'node', ['scripts/export-api.js', '--check']),
    runStep('the exported tree installs and runs', 'node', ['scripts/export-check.js']),
    runStep('dependency advisories are answered for', 'node', ['scripts/audit-dependencies.js']),
    await checkMigrations(),
    checkGeneratedMarked(
      Object.fromEntries(
        readdirSync('scripts')
          .filter((file) => file.endsWith('.js'))
          .map((file) => [file, readFileSync(`scripts/${file}`, 'utf8')]),
      ),
      readFileSync('.gitattributes', 'utf8'),
      execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean),
    ),
  ];
  try {
    const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' });
    results.push(checkVersion(readFileSync('package.json', 'utf8'), tags));
  } catch {
    results.push({ name: 'the version has moved since the last tag', ok: true, optional: true });
  }

  const outcome = summarise(results);
  for (const result of outcome.results) {
    console.log(
      `${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.detail ? ` (${result.detail})` : ''}`,
    );
  }
  console.log(outcome.ready ? 'ready to release' : `${outcome.failed} checks failed`);
  process.exitCode = outcome.ready ? 0 : 1;
}
