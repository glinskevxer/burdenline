/**
 * A sweep for exports nothing uses.
 *
 * Every one of them started as something a caller was going to need and then
 * did not, and they are worse than dead weight: they are read as api, so the
 * next person writing a caller finds a helper that has never been exercised and
 * uses it. This test is the reason to delete one rather than leave it.
 *
 * A deliberate exception is listed by name with a reason, which is the only kind
 * of exception worth having.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Exported for a reason other than being called from inside this repository. */
const KEPT = new Map([
  ['bootstrap', 'the entry point, called by src/index.js when it is the main module'],
  ['main', 'the entry point, called when the process starts'],
  ['buildServer', 'the http server without the routes, used by buildApp and by tests'],
]);

function jsFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return jsFiles(path);
    }
    return path.endsWith('.js') ? [path] : [];
  });
}

function exportsIn(text) {
  const names = [];
  for (const pattern of [
    /export (?:async )?function ([A-Za-z0-9_]+)/g,
    /export const ([A-Za-z0-9_]+)/g,
  ]) {
    for (const match of text.matchAll(pattern)) {
      names.push(match[1]);
    }
  }
  return names;
}

describe('the exported surface', () => {
  const sourceFiles = jsFiles('src');
  const everything = [...sourceFiles, ...jsFiles('tests'), ...jsFiles('scripts'), ...jsFiles('bin')]
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  it('has something using every export', () => {
    const unused = [];
    for (const path of sourceFiles) {
      const text = readFileSync(path, 'utf8');
      for (const name of exportsIn(text)) {
        if (KEPT.has(name)) {
          continue;
        }
        const uses = everything.match(new RegExp(`\\b${name}\\b`, 'g')) ?? [];
        if (uses.length <= 1) {
          unused.push(`${path}: ${name}`);
        }
      }
    }
    expect(unused).toEqual([]);
  });

  it('gives every deliberate exception a reason', () => {
    for (const [name, reason] of KEPT) {
      expect(reason.length).toBeGreaterThan(20);
      expect(typeof name).toBe('string');
    }
  });

  it('finds the exports it is supposed to be looking at', () => {
    const names = exportsIn(readFileSync('src/lib/guards.js', 'utf8'));
    expect(names).toContain('requirePositive');
    expect(names).toContain('pick');
  });

  it('reads every source file, not just the top level ones', () => {
    expect(sourceFiles.length).toBeGreaterThan(90);
    expect(sourceFiles).toContain(join('src', 'domain', 'geometry', 'points.js'));
  });
});
