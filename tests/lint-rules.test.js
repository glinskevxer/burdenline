/**
 * The lint rules that are here for a reason.
 *
 * Each of these was added after something went wrong, and a rule with no reason
 * beside it is a rule the next person turns off. This test is where the reasons
 * live, and it fails if one is quietly removed from the configuration.
 */

import { describe, it, expect } from 'vitest';
import config from '../eslint.config.js';

const REASONS = new Map([
  ['no-shadow', 'a repository shadowed db with a parameter and wrote to the wrong connection'],
  ['no-param-reassign', 'a domain function edited the object a caller still held'],
  ['eqeqeq', 'a hole number came in as a string from a form and matched a number'],
  ['no-console', 'a debugging line shipped and wrote a token into the container log'],
  ['no-var', 'a loop variable leaked out of a block and was reused three lines later'],
  ['no-implicit-coercion', 'a double negation hid a missing value being read as false'],
  ['no-unneeded-ternary', 'a ternary returning true and false read as a rule when it was a cast'],
  ['max-depth', 'four levels of nesting in a checker is where the rules stop being readable'],
  ['no-else-return', 'an else after a return hid a second exit from a validation function'],
  ['no-lonely-if', 'a lonely if inside an else is a case somebody meant to fold in'],
  ['object-shorthand', 'consistency, so a diff shows a change rather than a style'],
  ['prefer-const', 'a rebound constant in a reduce was the cause of a silent wrong total'],
]);

/** The rules that apply to the source, before the relaxations for scripts and tests. */
function rulesOf(configuration) {
  return configuration
    .filter((block) => !(block.files ?? []).some((pattern) => pattern.startsWith('tests/')))
    .reduce((all, block) => ({ ...all, ...(block.rules ?? {}) }), {});
}

describe('the lint configuration', () => {
  const rules = rulesOf(config);

  it('carries every rule that has a reason written down', () => {
    const missing = [...REASONS.keys()].filter((rule) => rules[rule] === undefined);
    expect(missing).toEqual([]);
  });

  it('sets each of them to error rather than to a warning nobody reads', () => {
    for (const rule of REASONS.keys()) {
      const setting = rules[rule];
      const level = Array.isArray(setting) ? setting[0] : setting;
      expect([rule, level]).toEqual([rule, 'error']);
    }
  });

  it('gives every reason enough words to be a reason', () => {
    for (const [rule, reason] of REASONS) {
      expect([rule, reason.split(' ').length > 6]).toEqual([rule, true]);
    }
  });

  it('lets the console through in the places that are meant to print', () => {
    const printing = config.find((block) =>
      (block.files ?? []).some((pattern) => pattern.startsWith('scripts/')),
    );
    expect(printing.rules['no-console']).toBe('off');
  });

  it('ignores what should never be linted', () => {
    const ignores = config.find((block) => block.ignores)?.ignores ?? [];
    expect(ignores).toContain('node_modules/**');
    expect(ignores).toContain('coverage/**');
  });

  it('runs against the ecmascript version this codebase is written in', () => {
    const language = config.find((block) => block.languageOptions)?.languageOptions;
    expect(language.sourceType).toBe('module');
    expect(language.ecmaVersion).toBeGreaterThanOrEqual(2022);
  });
});
