/**
 * What we depend on, and what we have decided about it.
 *
 * Two separate worries. The first is drift: a range in `package.json` means the
 * thing that runs in production is not the thing anybody tested, so every
 * runtime dependency is pinned to one version and this checks that it stayed
 * pinned. The second is the audit gate. That gate is only worth having if the
 * acceptance file it reads cannot quietly rot, so the shape of an acceptance is
 * checked here rather than being discovered on the day the build goes red.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readAcceptances, findingsFrom, judge } from '../scripts/audit-dependencies.js';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const acceptedText = readFileSync('audit-accepted.json', 'utf8');
const EXACT = /^\d+\.\d+\.\d+$/;

describe('the runtime dependencies', () => {
  it('are all pinned to one version', () => {
    const loose = Object.entries(manifest.dependencies).filter(([, range]) => !EXACT.test(range));
    expect(loose).toEqual([]);
  });

  it('are pinned in the development set too, so a lint run is reproducible', () => {
    const loose = Object.entries(manifest.devDependencies).filter(
      ([, range]) => !EXACT.test(range),
    );
    expect(loose).toEqual([]);
  });

  it('name the node version this is built against', () => {
    expect(manifest.engines.node).toMatch(/^>=20\./);
  });

  it('agree with what the lock file resolved', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      const entry = lock.packages[`node_modules/${name}`];
      expect([name, entry?.version]).toEqual([name, version]);
    }
  });

  it('keep the http stack on a release that answers the known advisories', () => {
    // Both of these were bumped off the version this was started on because an
    // advisory landed against it. The floor is written down so that a later
    // downgrade fails here rather than in the audit job, where the reason would
    // not be visible.
    const atLeast = (version, floor) => {
      const [a, b, c] = version.split('.').map(Number);
      const [x, y, z] = floor.split('.').map(Number);
      return a !== x ? a > x : b !== y ? b > y : c >= z;
    };
    expect(atLeast(manifest.dependencies.fastify, '5.7.2')).toBe(true);
    expect(atLeast(manifest.dependencies['@fastify/jwt'], '10.0.0')).toBe(true);
  });
});

describe('the audit acceptance file', () => {
  it('parses and holds nothing that is already past review', () => {
    const today = new Date().toISOString().slice(0, 10);
    const { expired } = readAcceptances(acceptedText, today);
    expect(expired).toEqual([]);
  });

  it('refuses an acceptance with no reason', () => {
    const text = JSON.stringify({ accepted: [{ id: '1234', reviewBy: '2099-01-01' }] });
    expect(() => readAcceptances(text, '2026-01-01')).toThrow(/reason/);
  });

  it('refuses an acceptance with no review date', () => {
    const text = JSON.stringify({ accepted: [{ id: '1234', reason: 'it does not apply' }] });
    expect(() => readAcceptances(text, '2026-01-01')).toThrow(/reviewBy/);
  });

  it('treats a past review date as a failure rather than as an acceptance', () => {
    const text = JSON.stringify({
      accepted: [{ id: '1234', reason: 'looked at it', reviewBy: '2025-01-01' }],
    });
    const { accepted, expired } = readAcceptances(text, '2026-01-01');
    expect(accepted.size).toBe(0);
    expect(expired).toHaveLength(1);
  });
});

describe('the audit judgement', () => {
  const report = {
    vulnerabilities: {
      thing: {
        severity: 'high',
        via: [{ source: 900, severity: 'high', title: 'a hole', range: '<1.0.0' }, 'other'],
      },
      lesser: {
        severity: 'low',
        via: [{ source: 901, severity: 'low', title: 'a scratch', range: '<1.0.0' }],
      },
    },
  };

  it('reads one finding per advisory and skips the strings npm folds in', () => {
    const findings = findingsFrom(report);
    expect(findings.map((finding) => finding.id)).toEqual(['900', '901']);
    expect(findings[0].package).toBe('thing');
  });

  it('blocks on high and lets a low one through', () => {
    const { blocking, ignored } = judge(findingsFrom(report), new Map());
    expect(blocking.map((finding) => finding.id)).toEqual(['900']);
    expect(ignored.map((finding) => finding.id)).toEqual(['901']);
  });

  it('lets an accepted advisory through whatever its severity', () => {
    const accepted = new Map([['900', { id: '900', reason: 'not reachable from here' }]]);
    const { blocking, ignored } = judge(findingsFrom(report), accepted);
    expect(blocking).toEqual([]);
    expect(ignored).toHaveLength(2);
  });

  it('takes the floor it is given', () => {
    const { blocking } = judge(findingsFrom(report), new Map(), 'low');
    expect(blocking).toHaveLength(2);
  });
});
