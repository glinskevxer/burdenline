/**
 * The operational side: what a shot cost, what it produced, who complained
 * about it, who was told it was coming, and an audit trail over the lot.
 *
 * The audit table is not a log. A log is for the people running the server; this
 * is for the question asked two years later about who changed a receptor limit
 * and when, and it is written in the same transaction as the change so the two
 * cannot come apart.
 */

export const migration = {
  id: '004',
  name: 'costs, complaints, notifications and audit',
  up(db) {
    db.exec(`
      CREATE TABLE product_price (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
        unit TEXT NOT NULL,
        price_per_unit REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'EUR',
        effective_from TEXT NOT NULL,
        effective_to TEXT,
        supplier TEXT,
        created_at TEXT NOT NULL,
        CHECK (price_per_unit >= 0),
        CHECK (unit IN ('kg', 'each', 'metre')),
        CHECK (effective_to IS NULL OR effective_to > effective_from)
      );

      CREATE TABLE cost_rate (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        rate REAL NOT NULL,
        unit TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'EUR',
        effective_from TEXT NOT NULL,
        effective_to TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        CHECK (rate >= 0),
        CHECK (kind IN ('drilling', 'labour', 'secondary_breaking', 'survey', 'monitoring', 'overhead'))
      );

      CREATE TABLE blast_inspection (
        id TEXT PRIMARY KEY,
        blast_id TEXT NOT NULL REFERENCES blast(id) ON DELETE CASCADE,
        inspected_at TEXT NOT NULL,
        inspected_by TEXT REFERENCES person(id),
        muckpile_shape TEXT NOT NULL,
        throw_m REAL NOT NULL,
        muckpile_height_m REAL,
        toe_grade TEXT NOT NULL,
        toe_length_m REAL NOT NULL DEFAULT 0,
        backbreak_m REAL NOT NULL DEFAULT 0,
        oversize_count INTEGER NOT NULL DEFAULT 0,
        face_stable INTEGER NOT NULL DEFAULT 1,
        flyrock_observed INTEGER NOT NULL DEFAULT 0,
        fume_grade INTEGER NOT NULL DEFAULT 0,
        score REAL,
        note TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (blast_id),
        CHECK (muckpile_shape IN ('tight', 'moderate', 'loose', 'cast')),
        CHECK (toe_grade IN ('none', 'slight', 'moderate', 'severe')),
        CHECK (fume_grade BETWEEN 0 AND 5),
        CHECK (face_stable IN (0, 1)),
        CHECK (flyrock_observed IN (0, 1))
      );

      CREATE TABLE misfire (
        id TEXT PRIMARY KEY,
        blast_id TEXT NOT NULL REFERENCES blast(id) ON DELETE CASCADE,
        hole_numbers TEXT NOT NULL,
        kind TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        discovered_by TEXT REFERENCES person(id),
        explosive_estimate_kg REAL,
        description TEXT NOT NULL,
        made_safe_at TEXT,
        made_safe_by TEXT REFERENCES person(id),
        reported_to_regulator INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        CHECK (kind IN ('unfired_hole', 'partial_detonation', 'cut_off', 'unaccounted_explosive')),
        CHECK (reported_to_regulator IN (0, 1))
      );

      CREATE TABLE complaint (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
        receptor_id TEXT REFERENCES receptor(id) ON DELETE SET NULL,
        blast_id TEXT REFERENCES blast(id) ON DELETE SET NULL,
        received_at TEXT NOT NULL,
        received_by TEXT REFERENCES person(id),
        channel TEXT NOT NULL,
        complainant TEXT,
        contact TEXT,
        about TEXT NOT NULL,
        description TEXT NOT NULL,
        occurred_at TEXT,
        state TEXT NOT NULL DEFAULT 'open',
        outcome TEXT,
        closed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (channel IN ('telephone', 'email', 'letter', 'in_person', 'regulator', 'other')),
        CHECK (about IN ('vibration', 'airblast', 'dust', 'noise', 'flyrock', 'traffic', 'other')),
        CHECK (state IN ('open', 'investigating', 'responded', 'closed', 'withdrawn'))
      );

      CREATE TABLE notification (
        id TEXT PRIMARY KEY,
        blast_id TEXT NOT NULL REFERENCES blast(id) ON DELETE CASCADE,
        receptor_id TEXT REFERENCES receptor(id) ON DELETE SET NULL,
        channel TEXT NOT NULL,
        addressed_to TEXT NOT NULL,
        sent_at TEXT,
        planned_for TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'planned',
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        CHECK (channel IN ('telephone', 'text_message', 'email', 'letter', 'sign', 'in_person')),
        CHECK (state IN ('planned', 'sent', 'failed', 'not_required'))
      );

      CREATE TABLE audit_entry (
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        request_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX price_by_product ON product_price (product_id, effective_from);
      CREATE INDEX rate_by_site ON cost_rate (site_id, kind, effective_from);
      CREATE INDEX misfire_by_blast ON misfire (blast_id);
      CREATE INDEX complaint_by_site ON complaint (site_id, received_at);
      CREATE INDEX complaint_by_state ON complaint (site_id, state);
      CREATE INDEX notification_by_blast ON notification (blast_id, state);
      CREATE INDEX audit_by_entity ON audit_entry (entity_kind, entity_id, occurred_at);
      CREATE INDEX audit_by_actor ON audit_entry (actor_id, occurred_at);
    `);
  },
};

export default migration;
