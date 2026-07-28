/**
 * The things about a release that are worth a test rather than a checklist item.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const changelog = readFileSync('CHANGELOG.md', 'utf8');
/** Read with the line wrapping taken out, since prettier owns where the lines break. */
const changelogText = changelog.replace(/\s+/g, ' ');

describe('the package', () => {
  it('carries a version the changelog knows about', () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(changelog).toContain(`## ${packageJson.version}`);
  });

  it('is private, because this is not going on a registry', () => {
    expect(packageJson.private).toBe(true);
  });

  it('pins every dependency to an exact version', () => {
    const ranges = Object.entries({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    }).filter(([, version]) => /[\^~*x]|\s-\s/.test(version));
    expect(ranges).toEqual([]);
  });

  it('says which node it runs on, and it is one major line', () => {
    expect(packageJson.engines.node).toBe('>=20.18.0 <21');
  });

  it('has a script for everything the release check runs', () => {
    for (const script of [
      'lint',
      'format:check',
      'coverage',
      'test',
      'export-check',
      'api',
      'audit',
    ]) {
      expect(Object.keys(packageJson.scripts)).toContain(script);
    }
  });

  it('points its binary at a file that exists', () => {
    expect(() => readFileSync(packageJson.bin.burdenline, 'utf8')).not.toThrow();
  });
});

describe('the changelog', () => {
  it('says what changed rather than listing commits', () => {
    expect(changelog).not.toMatch(/^- [0-9a-f]{7} /m);
    expect(changelog.split('\n').length).toBeGreaterThan(20);
  });

  it('records the bugs the tests found, since those are the useful part', () => {
    expect(changelogText).toContain('end to end test');
    expect(changelogText).toContain('performance test');
  });

  it('says what is deliberate as well as what is done', () => {
    expect(changelogText).toContain('Known and deliberate');
  });
});

describe('the deployment artefacts', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  const compose = readFileSync('compose.yaml', 'utf8');
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

  it('builds on the same node the package says it runs on', () => {
    expect(dockerfile).toContain('node:20.18.1-bookworm-slim');
    expect(workflow).toContain("NODE_VERSION: '20.18.1'");
  });

  it('runs the image as a user that cannot write to the application', () => {
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('chown node:node /data');
  });

  it('checks the database is answering rather than that the process is alive', () => {
    expect(dockerfile).toContain('/ready');
    expect(dockerfile).toContain('HEALTHCHECK');
  });

  it('refuses to start without a signing secret', () => {
    expect(compose).toContain('BURDENLINE_JWT_SECRET:?');
  });

  it('gives the container time to finish a request on the way down', () => {
    expect(compose).toContain('stop_grace_period');
  });

  it('runs every gate in the pipeline', () => {
    for (const job of ['lint', 'test', 'coverage', 'audit', 'export', 'image']) {
      expect(workflow).toContain(`  ${job}:`);
    }
  });

  it('starts the image in the pipeline rather than only building it', () => {
    expect(workflow).toContain('the image starts and answers');
    expect(workflow).toContain('curl -fsS http://127.0.0.1:8080/ready');
  });
});
