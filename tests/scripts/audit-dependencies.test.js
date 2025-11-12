import { describe, it, expect } from 'vitest';
import { readAcceptances, findingsFrom, judge } from '../../scripts/audit-dependencies.js';

const today = '2025-11-12';

describe('readAcceptances', () => {
  it('reads an acceptance that is still in date', () => {
    const { accepted, expired } = readAcceptances(
      JSON.stringify({
        accepted: [{ id: '1099', reason: 'no path from our code to it', reviewBy: '2026-01-01' }],
      }),
      today,
    );
    expect(accepted.has('1099')).toBe(true);
    expect(expired).toHaveLength(0);
  });

  it('reports one that is past its review date rather than honouring it', () => {
    const { accepted, expired } = readAcceptances(
      JSON.stringify({ accepted: [{ id: '1099', reason: 'x', reviewBy: '2025-01-01' }] }),
      today,
    );
    expect(accepted.size).toBe(0);
    expect(expired).toHaveLength(1);
  });

  it('refuses an acceptance with no reason behind it', () => {
    expect(() => readAcceptances(JSON.stringify({ accepted: [{ id: '1099' }] }), today)).toThrow(
      /needs an id, a reason/,
    );
  });

  it('takes an empty list', () => {
    expect(readAcceptances(JSON.stringify({ accepted: [] }), today).accepted.size).toBe(0);
    expect(readAcceptances(JSON.stringify({}), today).accepted.size).toBe(0);
  });
});

describe('findingsFrom', () => {
  it('pulls one finding per advisory', () => {
    const findings = findingsFrom({
      vulnerabilities: {
        tar: {
          severity: 'high',
          via: [{ source: 1099, title: 'path traversal', severity: 'high', range: '<6.2.1' }],
        },
      },
    });
    expect(findings).toEqual([
      { id: '1099', package: 'tar', severity: 'high', title: 'path traversal', range: '<6.2.1' },
    ]);
  });

  it('skips the entries that only name another package', () => {
    const findings = findingsFrom({
      vulnerabilities: { a: { severity: 'high', via: ['b'] } },
    });
    expect(findings).toEqual([]);
  });

  it('reads an empty report as nothing to do', () => {
    expect(findingsFrom({})).toEqual([]);
  });
});

describe('judge', () => {
  const findings = [
    { id: '1', package: 'a', severity: 'critical', title: 'x' },
    { id: '2', package: 'b', severity: 'moderate', title: 'y' },
    { id: '3', package: 'c', severity: 'high', title: 'z' },
  ];

  it('blocks on anything at or above the floor', () => {
    const { blocking } = judge(findings, new Map(), 'high');
    expect(blocking.map((finding) => finding.id)).toEqual(['1', '3']);
  });

  it('lets an accepted advisory through whatever its severity', () => {
    const accepted = new Map([['1', { id: '1', reason: 'accepted', reviewBy: '2026-01-01' }]]);
    const { blocking, ignored } = judge(findings, accepted, 'high');
    expect(blocking.map((finding) => finding.id)).toEqual(['3']);
    expect(ignored.map((finding) => finding.id)).toEqual(['1', '2']);
  });

  it('follows a lower floor when the site wants one', () => {
    expect(judge(findings, new Map(), 'moderate').blocking).toHaveLength(3);
  });

  it('passes a clean report', () => {
    expect(judge([], new Map()).blocking).toEqual([]);
  });
});
