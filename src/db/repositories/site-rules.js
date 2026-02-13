/**
 * Reading and setting a site's own rule numbers.
 *
 * A set is never edited. Changing a rule writes a new row and stamps the old one
 * as superseded, so a design signed off in March can be explained against the
 * rules that were in force in March. That matters more here than in most places:
 * the question after an incident is what the rule was on the day, and an edited
 * row cannot answer it.
 */

import { ValidationError, NotFoundError } from '../../lib/errors.js';
import { inTransaction } from '../connection.js';
import { insertRow, getById, rowsToObjects } from '../repository.js';
import { newId } from '../../lib/ids.js';
import { DEFAULT_CHARGE_RULES } from '../../domain/charging/rules.js';
import { DEFAULT_TIMING_RULES } from '../../domain/initiation/timing-checks.js';
import { DEFAULT_EXCLUSION_RULES } from '../../domain/firing/exclusion.js';
import { DEFAULT_WEATHER_RULES } from '../../domain/firing/weather.js';
import { DEFAULT_NOTICE_RULES } from '../../domain/community/notifications.js';
import { DEFAULT_RECONCILE_RULES } from '../../domain/magazine/reconcile.js';
import { DEFAULT_BATCH_RULES } from '../../domain/magazine/batches.js';
import { DEFAULT_RESPONSE_RULES } from '../../domain/community/complaints.js';

export const RULE_SETS = Object.freeze({
  charge: DEFAULT_CHARGE_RULES,
  timing: DEFAULT_TIMING_RULES,
  exclusion: DEFAULT_EXCLUSION_RULES,
  weather: DEFAULT_WEATHER_RULES,
  notice: DEFAULT_NOTICE_RULES,
  reconcile: DEFAULT_RECONCILE_RULES,
  batch: DEFAULT_BATCH_RULES,
  response: DEFAULT_RESPONSE_RULES,
});

export function ruleSetNames() {
  return Object.keys(RULE_SETS).sort();
}

export function defaultsFor(name) {
  const defaults = RULE_SETS[name];
  if (!defaults) {
    throw new ValidationError(`${name} is not a rule set`, [
      { path: 'ruleSet', message: `expected one of ${ruleSetNames().join(', ')}`, kind: 'enum' },
    ]);
  }
  return defaults;
}

/**
 * The rules in force for a site, which is the defaults with whatever the site
 * has overridden laid over them. A site that has never set anything gets the
 * defaults, and that is reported rather than hidden.
 */
export function rulesFor(db, siteId, name) {
  const defaults = defaultsFor(name);
  const row = db
    .prepare(
      `SELECT * FROM site_rules
       WHERE site_id = ? AND rule_set = ? AND superseded_at IS NULL
       ORDER BY effective_from DESC LIMIT 1`,
    )
    .get(siteId, name);
  if (!row) {
    return { ruleSet: name, values: { ...defaults }, source: 'default', setAt: null };
  }
  return {
    ruleSet: name,
    values: { ...defaults, ...JSON.parse(row.values_json) },
    overrides: JSON.parse(row.values_json),
    source: 'site',
    setAt: row.effective_from,
    setBy: row.set_by,
    note: row.note,
  };
}

export function allRulesFor(db, siteId) {
  return Object.fromEntries(ruleSetNames().map((name) => [name, rulesFor(db, siteId, name)]));
}

/** Set an override. Only keys the rule set already has may be given a value. */
export function setRules(db, { siteId, ruleSet, values, setBy = null, note = null }, { clock }) {
  getById(db, 'site', siteId, { kind: 'site' });
  const defaults = defaultsFor(ruleSet);
  const unknown = Object.keys(values ?? {}).filter((key) => !(key in defaults));
  if (unknown.length > 0) {
    throw new ValidationError(
      `the ${ruleSet} rules have no ${unknown.join(' or ')}`,
      unknown.map((key) => ({ path: key, message: 'not a rule in this set', kind: 'enum' })),
    );
  }
  for (const [key, value] of Object.entries(values ?? {})) {
    if (typeof value !== typeof defaults[key]) {
      throw new ValidationError(`${key} should be a ${typeof defaults[key]}`, [
        { path: key, message: `expected a ${typeof defaults[key]}`, kind: 'type' },
      ]);
    }
  }
  const now = clock.now();
  return inTransaction(db, () => {
    db.prepare(
      `UPDATE site_rules SET superseded_at = ?
       WHERE site_id = ? AND rule_set = ? AND superseded_at IS NULL`,
    ).run(now, siteId, ruleSet);
    const row = {
      id: newId('rep'),
      siteId,
      ruleSet,
      valuesJson: JSON.stringify(values ?? {}),
      effectiveFrom: now,
      supersededAt: null,
      setBy,
      note,
      createdAt: now,
    };
    insertRow(db, 'site_rules', row);
    return rulesFor(db, siteId, ruleSet);
  });
}

export function history(db, siteId, ruleSet) {
  defaultsFor(ruleSet);
  const rows = db
    .prepare(
      'SELECT * FROM site_rules WHERE site_id = ? AND rule_set = ? ORDER BY effective_from DESC',
    )
    .all(siteId, ruleSet);
  return rowsToObjects(rows).map((row) => ({ ...row, values: JSON.parse(row.valuesJson) }));
}

/** Put a set back to the defaults, which is a change like any other. */
export function resetRules(db, { siteId, ruleSet, setBy = null }, { clock }) {
  const current = rulesFor(db, siteId, ruleSet);
  if (current.source === 'default') {
    throw new NotFoundError('site rule override', `${siteId}:${ruleSet}`);
  }
  return setRules(
    db,
    { siteId, ruleSet, values: {}, setBy, note: 'reset to the defaults' },
    { clock },
  );
}
