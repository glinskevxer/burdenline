/**
 * The conventions this codebase actually holds to.
 *
 * Written down as tests rather than in a style guide, because a style guide is
 * read once and a failing test is read on the day it breaks. Each of these is a
 * property somebody relied on: that a module says at the top what it is for,
 * that the domain does not reach for the database, that a route names the
 * permission it needs, and that nothing prints to the console outside the places
 * meant to print.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { standUp } from './http/helpers.js';

function jsFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return jsFiles(path);
    }
    return path.endsWith('.js') ? [path] : [];
  });
}

const sourceFiles = jsFiles('src');
const read = (path) => readFileSync(path, 'utf8');

describe('every module', () => {
  it('opens by saying what it is for', () => {
    const silent = sourceFiles.filter((path) => !read(path).trimStart().startsWith('/**'));
    expect(silent).toEqual([]);
  });

  it('says it in more than a line', () => {
    const thin = sourceFiles.filter((path) => {
      const header = read(path).split('*/')[0];
      return header.split('\n').length < 4;
    });
    expect(thin).toEqual([]);
  });
});

describe('the domain', () => {
  const domainFiles = sourceFiles.filter((path) => path.startsWith(join('src', 'domain')));

  it('is a real proportion of the codebase, which is the point of the shape', () => {
    expect(domainFiles.length).toBeGreaterThan(25);
  });

  it('never reaches for the database', () => {
    const reaching = domainFiles.filter((path) => /from '[^']*\/db\//.test(read(path)));
    expect(reaching).toEqual([]);
  });

  it('never reaches for http', () => {
    const reaching = domainFiles.filter((path) => /from '[^']*\/http\//.test(read(path)));
    expect(reaching).toEqual([]);
  });

  it('never reads the clock for itself', () => {
    const reaching = domainFiles.filter((path) => /Date\.now\(\)|new Date\(\)/.test(read(path)));
    expect(reaching).toEqual([]);
  });

  it('never reads the environment', () => {
    const reaching = domainFiles.filter((path) => /process\.env/.test(read(path)));
    expect(reaching).toEqual([]);
  });
});

describe('the repositories', () => {
  const repositoryFiles = sourceFiles.filter((path) =>
    path.startsWith(join('src', 'db', 'repositories')),
  );

  it('never reach for http', () => {
    const reaching = repositoryFiles.filter((path) => /from '[^']*\/http\//.test(read(path)));
    expect(reaching).toEqual([]);
  });

  it('leave the three append only tables without an update', () => {
    const text = repositoryFiles.map(read).join('\n');
    for (const table of ['magazine_ledger', 'blast_event', 'audit_entry']) {
      expect([table, new RegExp(`UPDATE ${table}`).test(text)]).toEqual([table, false]);
      expect([table, text.includes(`updateRow(db, '${table}'`)]).toEqual([table, false]);
    }
  });
});

describe('printing', () => {
  it('happens only where it is meant to', () => {
    const printing = sourceFiles.filter((path) => /console\.(log|info|warn)\(/.test(read(path)));
    expect(printing).toEqual([]);
  });
});

describe('the routes', () => {
  it('all name the permission they need', async () => {
    const routeFiles = sourceFiles.filter((path) => path.startsWith(join('src', 'http', 'routes')));
    for (const path of routeFiles) {
      const text = read(path);
      const handlers = text.match(/app\.(get|post|put|patch|delete)\(/g) ?? [];
      const guards = text.match(/requireGrant\(/g) ?? [];
      expect([path, guards.length]).toEqual([path, handlers.length]);
    }
  });

  it('answer a problem document on every refusal', async () => {
    const harness = await standUp();
    try {
      for (const [method, url, role] of [
        ['GET', '/sites', undefined],
        ['GET', '/sites/site_missing', 'viewer'],
        ['POST', '/sites', 'viewer'],
        ['GET', '/nowhere', 'viewer'],
      ]) {
        const response = await harness.request(method, url, role, undefined);
        expect([url, response.statusCode >= 400]).toEqual([url, true]);
        expect([url, response.headers['content-type']]).toEqual([
          url,
          expect.stringContaining('application/problem+json'),
        ]);
        expect([url, typeof response.json().requestId]).toEqual([url, 'string']);
      }
    } finally {
      await harness.close();
    }
  });
});
