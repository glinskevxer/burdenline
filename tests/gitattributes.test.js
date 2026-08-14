/**
 * The generated files, and the mark that says so.
 *
 * `api.json` is written by a script and checked in on purpose, so a route
 * appearing or disappearing shows up in a diff. The cost of checking it in is
 * that GitHub counts it as code somebody wrote, which moves the repository's
 * language statistics and reads in a review as nine hundred lines of hand
 * written JSON. `linguist-generated=true` in `.gitattributes` answers that.
 *
 * The reason this is a test rather than a comment is the next generator. Nobody
 * adding one will read a comment in a file they are not editing, so the release
 * check reads the scripts and finds the targets itself, and these hold that
 * reader honest.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  generatedTargets,
  markedGenerated,
  checkGeneratedMarked,
} from '../scripts/release-check.js';

const attributes = readFileSync('.gitattributes', 'utf8');
const scripts = Object.fromEntries(
  readdirSync('scripts')
    .filter((file) => file.endsWith('.js'))
    .map((file) => [file, readFileSync(`scripts/${file}`, 'utf8')]),
);

describe('the file itself', () => {
  it('settles line endings so a windows checkout is not one enormous diff', () => {
    expect(attributes).toMatch(/^\*\s+text=auto\s+eol=lf$/m);
  });

  it('marks the api description', () => {
    expect(markedGenerated(attributes)).toContain('api.json');
  });

  it('marks the lock file, which nobody typed either', () => {
    expect(markedGenerated(attributes)).toContain('package-lock.json');
  });

  it('marks nothing that is not actually generated', () => {
    for (const path of markedGenerated(attributes)) {
      expect([path, /\.(json|lock)$/.test(path)]).toEqual([path, true]);
    }
  });
});

describe('reading the targets out of the scripts', () => {
  it('finds what this repository generates today', () => {
    expect(generatedTargets(scripts)).toEqual(['api.json']);
  });

  it('follows a constant rather than needing the path written at the call', () => {
    const source = { 'a.js': "const OUT = 'thing.json';\nwriteFileSync(OUT, body);" };
    expect(generatedTargets(source)).toEqual(['thing.json']);
  });

  it('takes a path written straight into the call', () => {
    const source = { 'a.js': "writeFileSync('other.json', body);" };
    expect(generatedTargets(source)).toEqual(['other.json']);
  });

  it('leaves an absolute path alone, since that is somewhere else on the machine', () => {
    const source = { 'a.js': "writeFileSync('/tmp/scratch.json', body);" };
    expect(generatedTargets(source)).toEqual([]);
  });

  it('leaves a path built at run time alone, because there is no one file to mark', () => {
    const source = { 'a.js': 'writeFileSync(`backup-${stamp}.db`, body);' };
    expect(generatedTargets(source)).toEqual([]);
  });

  it('says each target once however many scripts write it', () => {
    const source = {
      'a.js': "writeFileSync('same.json', body);",
      'b.js': "writeFileSync('same.json', body);",
    };
    expect(generatedTargets(source)).toEqual(['same.json']);
  });
});

describe('the gate', () => {
  const source = { 'a.js': "const OUT = 'made.json';\nwriteFileSync(OUT, body);" };
  const lineEndings = '* text=auto eol=lf\n';

  it('passes when the generated file is marked', () => {
    const result = checkGeneratedMarked(
      source,
      `${lineEndings}made.json linguist-generated=true\n`,
      ['made.json'],
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toBeNull();
  });

  it('fails when it is not, and names it', () => {
    const result = checkGeneratedMarked(source, lineEndings, ['made.json']);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('made.json');
  });

  it('ignores a target git does not track, which is scratch output', () => {
    const result = checkGeneratedMarked(source, lineEndings, ['something-else.js']);
    expect(result.ok).toBe(true);
  });

  it('fails when the line ending rule has been dropped', () => {
    const result = checkGeneratedMarked(source, 'made.json linguist-generated=true\n', [
      'made.json',
    ]);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('eol=lf');
  });

  it('reads a commented out mark as no mark at all', () => {
    const result = checkGeneratedMarked(
      source,
      `${lineEndings}# made.json linguist-generated=true\n`,
      ['made.json'],
    );
    expect(result.ok).toBe(false);
  });

  it('passes on this repository as it stands', () => {
    const tracked = ['api.json', 'package-lock.json', 'src/index.js'];
    expect(checkGeneratedMarked(scripts, attributes, tracked).ok).toBe(true);
  });
});
