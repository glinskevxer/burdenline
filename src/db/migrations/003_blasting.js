/**
 * The shot itself and everything recorded around it: the design that was
 * approved, the charge that went in each hole, the tie-in, the clearance, the
 * people, the receptors and what the monitors heard.
 *
 * The blast row holds the state and the reference; everything that happened to
 * it is in blast_event, appended and never updated, so the history of a shot
 * survives an edit to the row. That is the same decision as the magazine ledger
 * and for the same reason: these records are read years later by people asking
 * what was known at the time.
 */

export const migration = {
  id: '003',
  name: 'blasting, people and monitoring',
  up(db) {
    db.exec(`
      CREATE TABLE person (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        roles TEXT NOT NULL,
        employer TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (active IN (0, 1))
      );

      CREATE TABLE certificate (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        reference TEXT,
        issued_on TEXT NOT NULL,
        expires_on TEXT NOT NULL,
        endorsements TEXT NOT NULL DEFAULT '',
        suspended INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (kind IN ('shotfirer', 'medical', 'refresher', 'competence')),
        CHECK (expires_on > issued_on),
        CHECK (suspended IN (0, 1))
      );

      CREATE TABLE receptor (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        structure_class TEXT NOT NULL,
        easting_m REAL NOT NULL,
        northing_m REAL NOT NULL,
        level_m REAL NOT NULL DEFAULT 0,
        occupied INTEGER NOT NULL DEFAULT 1,
        limit_mm_per_second REAL,
        airblast_limit_db REAL,
        typical_frequency_hz REAL,
        monitored INTEGER NOT NULL DEFAULT 0,
        notifiable INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (site_id, name),
        CHECK (occupied IN (0, 1)),
        CHECK (monitored IN (0, 1)),
        CHECK (notifiable IN (0, 1)),
        CHECK (limit_mm_per_second IS NULL OR limit_mm_per_second > 0)
      );

      CREATE TABLE blast (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES site(id) ON DELETE RESTRICT,
        pattern_id TEXT REFERENCES pattern(id) ON DELETE SET NULL,
        reference TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL DEFAULT 'draft',
        designed_by TEXT REFERENCES person(id),
        approved_by TEXT REFERENCES person(id),
        shotfirer_id TEXT REFERENCES person(id),
        planned_for TEXT,
        fired_at TEXT,
        total_charge_kg REAL,
        instantaneous_charge_kg REAL,
        hole_count INTEGER,
        volume_m3 REAL,
        powder_factor_kg_m3 REAL,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (state IN ('draft', 'designed', 'submitted', 'approved', 'loaded', 'tied_in',
                         'cleared', 'fired', 'misfired', 'made_safe', 'inspected', 'closed', 'abandoned')),
        CHECK (total_charge_kg IS NULL OR total_charge_kg >= 0),
        CHECK (instantaneous_charge_kg IS NULL OR instantaneous_charge_kg >= 0)
      );

      CREATE TABLE blast_event (
        id TEXT PRIMARY KEY,
        blast_id TEXT NOT NULL REFERENCES blast(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        state_from TEXT NOT NULL,
        state_to TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor_id TEXT REFERENCES person(id),
        reason TEXT,
        payload TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE charge_deck (
        id TEXT PRIMARY KEY,
        blast_id TEXT NOT NULL REFERENCES blast(id) ON DELETE CASCADE,
        hole_id TEXT NOT NULL REFERENCES hole(id) ON DELETE CASCADE,
        deck_number INTEGER NOT NULL,
        kind TEXT NOT NULL,
        product_id TEXT REFERENCES product(id),
        batch_id TEXT REFERENCES product_batch(id),
        from_toe_m REAL NOT NULL,
        to_toe_m REAL NOT NULL,
        mass_kg REAL NOT NULL DEFAULT 0,
        primed INTEGER NOT NULL DEFAULT 0,
        booster_count INTEGER NOT NULL DEFAULT 0,
        in_hole_delay_ms REAL,
        created_at TEXT NOT NULL,
        UNIQUE (hole_id, deck_number),
        CHECK (kind IN ('charge', 'stemming', 'air', 'inert')),
        CHECK (to_toe_m > from_toe_m),
        CHECK (mass_kg >= 0),
        CHECK (primed IN (0, 1))
      );

      CREATE TABLE tie_in_connector (
        id TEXT PRIMARY KEY,
        blast_id TEXT NOT NULL REFERENCES blast(id) ON DELETE CASCADE,
        from_hole INTEGER NOT NULL,
        to_hole INTEGER NOT NULL,
        delay_ms REAL NOT NULL,
        detonator_code TEXT,
        created_at TEXT NOT NULL,
        CHECK (from_hole <> to_hole),
        CHECK (delay_ms >= 0)
      );

      CREATE TABLE clearance_item (
        id TEXT PRIMARY KEY,
        blast_id TEXT NOT NULL REFERENCES blast(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL,
        category TEXT NOT NULL,
        label TEXT NOT NULL,
        mandatory INTEGER NOT NULL DEFAULT 1,
        valid_for_minutes INTEGER NOT NULL,
        checked_at TEXT,
        checked_by TEXT REFERENCES person(id),
        note TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (blast_id, item_key),
        CHECK (mandatory IN (0, 1)),
        CHECK (valid_for_minutes > 0)
      );

      CREATE TABLE monitor_record (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
        receptor_id TEXT REFERENCES receptor(id) ON DELETE SET NULL,
        blast_id TEXT REFERENCES blast(id) ON DELETE SET NULL,
        monitor_serial TEXT NOT NULL,
        triggered_at TEXT NOT NULL,
        distance_m REAL,
        peak_mm_per_second REAL NOT NULL,
        peak_component TEXT,
        peak_frequency_hz REAL,
        longitudinal_mm_per_second REAL,
        transverse_mm_per_second REAL,
        vertical_mm_per_second REAL,
        vector_sum_mm_per_second REAL,
        airblast_db REAL,
        source_file TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (monitor_serial, triggered_at),
        CHECK (peak_mm_per_second >= 0)
      );

      CREATE TABLE site_law (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
        receptor_id TEXT REFERENCES receptor(id) ON DELETE CASCADE,
        k REAL NOT NULL,
        b REAL NOT NULL,
        scaling TEXT NOT NULL DEFAULT 'square_root',
        record_count INTEGER NOT NULL,
        r_squared REAL,
        residual_standard_error REAL,
        fitted_at TEXT NOT NULL,
        superseded_at TEXT,
        created_at TEXT NOT NULL,
        CHECK (k > 0 AND b > 0),
        CHECK (scaling IN ('square_root', 'cube_root'))
      );

      CREATE INDEX blast_by_site ON blast (site_id, state);
      CREATE INDEX blast_by_fired ON blast (fired_at);
      CREATE INDEX event_by_blast ON blast_event (blast_id, occurred_at);
      CREATE INDEX deck_by_blast ON charge_deck (blast_id);
      CREATE INDEX record_by_blast ON monitor_record (blast_id);
      CREATE INDEX record_by_time ON monitor_record (site_id, triggered_at);
      CREATE INDEX certificate_by_person ON certificate (person_id, expires_on);
      CREATE INDEX law_by_site ON site_law (site_id, receptor_id, superseded_at);
    `);
  },
};

export default migration;
