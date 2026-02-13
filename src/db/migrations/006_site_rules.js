/**
 * Rules a site sets for itself.
 *
 * Every rule set in the domain has a default and every one of them is a number
 * somebody at a particular quarry has an opinion about: the minimum stemming,
 * how long a clearance item stays fresh, what wind speed stops a shot. Until now
 * those defaults were only overridable by a caller passing them in, which in
 * practice meant they were not overridable at all.
 *
 * They are stored as one row per site per rule set, with the values as json,
 * because the shape of each set belongs to the domain module that owns it and
 * spreading twenty columns across six tables would fix that shape in the schema.
 */

export const migration = {
  id: '006',
  name: 'site rule sets',
  up(db) {
    db.exec(`
      CREATE TABLE site_rules (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
        rule_set TEXT NOT NULL,
        values_json TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        superseded_at TEXT,
        set_by TEXT REFERENCES person(id),
        note TEXT,
        created_at TEXT NOT NULL,
        CHECK (rule_set IN ('charge', 'timing', 'exclusion', 'weather', 'notice', 'reconcile', 'batch', 'response'))
      );

      CREATE INDEX rules_by_site ON site_rules (site_id, rule_set, superseded_at);
    `);
  },
};

export default migration;
