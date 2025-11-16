#!/usr/bin/env node
/**
 * Check what actually ships.
 *
 * The working tree passes. That says less than it looks like it does: it has
 * files git has never heard of, a node_modules built up over months, and
 * whatever happens to be lying about. This exports the tree exactly as git holds
 * it, installs from the lock file in a clean directory, and starts the thing
 * there. It has already caught a script that required a package nobody had
 * declared, and a module that only imported because an old build artefact was
 * still sitting in the working tree.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEEP = process.env.EXPORT_CHECK_KEEP === '1';

export function requiredPaths(packageJson) {
  const paths = new Set();
  if (packageJson.main) {
    paths.add(packageJson.main);
  }
  for (const target of Object.values(packageJson.bin ?? {})) {
    paths.add(target);
  }
  for (const script of Object.values(packageJson.scripts ?? {})) {
    const match = /^node ([\w./-]+)/.exec(script);
    if (match) {
      paths.add(match[1]);
    }
  }
  return [...paths].sort();
}

export function missingFrom(directory, paths) {
  return paths.filter((path) => !existsSync(join(directory, path)));
}

function runIn(directory, command, args) {
  return execFileSync(command, args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const workspace = mkdtempSync(join(tmpdir(), 'burdenline-export-'));
  const steps = [];
  try {
    execFileSync('sh', ['-c', `git archive HEAD | tar -x -C ${workspace}`], { stdio: 'pipe' });
    steps.push('exported the tree git holds');

    const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
    const missing = missingFrom(workspace, requiredPaths(packageJson));
    if (missing.length > 0) {
      throw new Error(`the export is missing ${missing.join(', ')}`);
    }
    steps.push('every path package.json points at is in the export');

    runIn(workspace, 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund']);
    steps.push('installed from the lock file with no development dependencies');

    const help = runIn(workspace, 'node', ['bin/burdenline.js', 'help']);
    if (!help.includes('burdenline <command>')) {
      throw new Error('the command line tool did not print its help');
    }
    steps.push('the command line tool runs');

    runIn(workspace, 'node', ['-e', "import('./src/index.js').then(() => console.log('loaded'))"]);
    steps.push('the server module loads');

    const migrated = runIn(workspace, 'node', ['bin/burdenline.js', 'migrate']);
    if (!migrated.includes('applied')) {
      throw new Error(`migrate did not apply anything: ${migrated}`);
    }
    steps.push('migrations run against a fresh database');

    for (const step of steps) {
      console.log(`ok  ${step}`);
    }
    console.log('export check passed');
  } catch (error) {
    for (const step of steps) {
      console.log(`ok  ${step}`);
    }
    console.error(`failed: ${error.message}`);
    if (error.stderr) {
      console.error(String(error.stderr).slice(0, 2000));
    }
    process.exitCode = 1;
  } finally {
    if (!KEEP) {
      rmSync(workspace, { recursive: true, force: true });
    } else {
      console.log(`kept at ${workspace}`);
    }
  }
}
