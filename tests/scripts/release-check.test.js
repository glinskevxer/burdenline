import { describe, it, expect } from 'vitest';
import { runStep, checkMigrations, checkVersion, summarise } from '../../scripts/release-check.js';

describe('runStep', () => {
  it('passes a command that succeeds', () => {
    const result = runStep('a command that works', 'node', ['-e', 'process.exit(0)']);
    expect(result.ok).toBe(true);
    expect(result.name).toBe('a command that works');
  });

  it('fails a command that does not, and keeps the tail of what it said', () => {
    const result = runStep('a command that fails', 'node', [
      '-e',
      "console.error('the thing went wrong'); process.exit(1)",
    ]);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('the thing went wrong');
  });

  it('marks an optional step as optional', () => {
    expect(
      runStep('optional', 'node', ['-e', 'process.exit(1)'], { optional: true }).optional,
    ).toBe(true);
  });
});

describe('checkMigrations', () => {
  it('applies every migration to a fresh database and finds no drift', async () => {
    const result = await checkMigrations();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('0 pending');
  });
});

describe('checkVersion', () => {
  it('passes a version that has not been tagged', () => {
    const result = checkVersion('{"version":"0.2.0"}', 'v0.1.0\nv0.1.1');
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('releasing 0.2.0');
  });

  it('fails one that has', () => {
    const result = checkVersion('{"version":"0.1.1"}', 'v0.1.0\nv0.1.1');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('already tagged');
  });

  it('takes tags with and without the leading letter', () => {
    expect(checkVersion('{"version":"0.1.0"}', '0.1.0').ok).toBe(false);
  });

  it('passes when nothing has ever been tagged', () => {
    expect(checkVersion('{"version":"0.1.0"}', '').ok).toBe(true);
  });
});

describe('summarise', () => {
  it('is ready when everything passed', () => {
    const outcome = summarise([
      { name: 'a', ok: true },
      { name: 'b', ok: true },
    ]);
    expect(outcome).toMatchObject({ steps: 2, failed: 0, ready: true });
  });

  it('is not ready when something failed', () => {
    expect(summarise([{ name: 'a', ok: false }]).ready).toBe(false);
  });

  it('does not fail the release on an optional step', () => {
    const outcome = summarise([{ name: 'a', ok: false, optional: true }]);
    expect(outcome.ready).toBe(true);
    expect(outcome.failed).toBe(0);
  });
});
