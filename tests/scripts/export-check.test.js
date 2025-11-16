import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requiredPaths, missingFrom } from '../../scripts/export-check.js';

const directories = [];

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'burdenline-export-test-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop(), { recursive: true, force: true });
  }
});

describe('requiredPaths', () => {
  it('collects the entry point, the binaries and anything a script runs', () => {
    expect(
      requiredPaths({
        main: 'src/index.js',
        bin: { burdenline: 'bin/burdenline.js' },
        scripts: { backup: 'node scripts/backup.js', test: 'vitest run' },
      }),
    ).toEqual(['bin/burdenline.js', 'scripts/backup.js', 'src/index.js']);
  });

  it('takes a package with none of them', () => {
    expect(requiredPaths({})).toEqual([]);
  });

  it('does not treat a script that is not a node invocation as a path', () => {
    expect(requiredPaths({ scripts: { lint: 'eslint .' } })).toEqual([]);
  });
});

describe('missingFrom', () => {
  it('says nothing when every path is there', () => {
    const directory = workspace();
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'src/index.js'), '');
    expect(missingFrom(directory, ['src/index.js'])).toEqual([]);
  });

  it('names the paths that are not', () => {
    const directory = workspace();
    expect(missingFrom(directory, ['src/index.js', 'bin/burdenline.js'])).toEqual([
      'src/index.js',
      'bin/burdenline.js',
    ]);
  });
});

describe('the real package', () => {
  it('points at paths this repository actually has', async () => {
    const { readFileSync } = await import('node:fs');
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(missingFrom(process.cwd(), requiredPaths(packageJson))).toEqual([]);
  });
});
