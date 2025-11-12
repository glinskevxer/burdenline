#!/usr/bin/env node
/**
 * The dependency audit gate.
 *
 * `npm audit` on its own is not a gate, because it fails the build on the day
 * an advisory is published whether or not anybody can do anything about it, and
 * a build that fails for reasons nobody can fix gets ignored. This turns it into
 * a decision: an advisory is either fixed, or it is written down in
 * `audit-accepted.json` with a reason and a date to look at it again. An
 * acceptance that has passed its review date fails the build, which is the point.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];
const FAIL_AT = process.env.AUDIT_FAIL_AT ?? 'high';

export function readAcceptances(text, today) {
  const parsed = JSON.parse(text);
  const accepted = new Map();
  const expired = [];
  for (const entry of parsed.accepted ?? []) {
    if (!entry.id || !entry.reason || !entry.reviewBy) {
      throw new Error(
        `an acceptance needs an id, a reason and a reviewBy: ${JSON.stringify(entry)}`,
      );
    }
    if (entry.reviewBy < today) {
      expired.push(entry);
      continue;
    }
    accepted.set(String(entry.id), entry);
  }
  return { accepted, expired };
}

export function findingsFrom(report) {
  const findings = [];
  for (const [name, advisory] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of advisory.via ?? []) {
      if (typeof via === 'string') {
        continue;
      }
      findings.push({
        id: String(via.source ?? via.url ?? name),
        package: name,
        severity: via.severity ?? advisory.severity,
        title: via.title ?? 'unknown advisory',
        range: via.range ?? advisory.range ?? '',
      });
    }
  }
  return findings;
}

export function judge(findings, accepted, failAt = FAIL_AT) {
  const floor = SEVERITY_ORDER.indexOf(failAt);
  const blocking = [];
  const ignored = [];
  for (const finding of findings) {
    if (accepted.has(finding.id)) {
      ignored.push(finding);
      continue;
    }
    if (SEVERITY_ORDER.indexOf(finding.severity) >= floor) {
      blocking.push(finding);
    } else {
      ignored.push(finding);
    }
  }
  return { blocking, ignored };
}

function auditReport() {
  try {
    const output = execFileSync('npm', ['audit', '--json', '--omit=dev'], { encoding: 'utf8' });
    return JSON.parse(output);
  } catch (error) {
    if (error.stdout) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const today = new Date().toISOString().slice(0, 10);
  const { accepted, expired } = readAcceptances(readFileSync('audit-accepted.json', 'utf8'), today);
  for (const entry of expired) {
    console.error(`acceptance for ${entry.id} was due for review on ${entry.reviewBy}`);
  }
  const { blocking, ignored } = judge(findingsFrom(auditReport()), accepted);
  for (const finding of blocking) {
    console.error(`${finding.severity} ${finding.package} ${finding.title} (${finding.id})`);
  }
  console.log(`${blocking.length} blocking, ${ignored.length} accepted or below the floor`);
  process.exit(blocking.length > 0 || expired.length > 0 ? 1 : 0);
}
