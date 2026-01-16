/**
 * The production side: what the shot actually yielded, what had to be broken
 * again afterwards, what has been ordered to replace what was used, and which
 * rig drilled it.
 *
 * A survey is kept separately from the design volume rather than replacing it.
 * The two disagree on nearly every shot and the difference is the interesting
 * number: it is overbreak, or it is a face that was not where the plan said, and
 * either way it is lost the moment somebody overwrites the design figure.
 */

export const migration = {
  id: '005',
  name: 'survey, secondary breaking, orders and rigs',
  up(db) {
    db.exec(`
      CREATE TABLE survey (
        id TEXT PRIMARY KEY,
        blast_id TEXT NOT NULL REFERENCES blast(id) ON DELETE CASCADE,
        surveyed_at TEXT NOT NULL,
        surveyed_by TEXT REFERENCES person(id),
        method TEXT NOT NULL,
        volume_m3 REAL NOT NULL,
        tonnes REAL,
        density_kg_m3 REAL,
        overbreak_m3 REAL,
        note TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (blast_id, surveyed_at),
        CHECK (method IN ('laser_scan', 'drone_photogrammetry', 'total_station', 'truck_count', 'weighbridge')),
        CHECK (volume_m3 > 0),
        CHECK (tonnes IS NULL OR tonnes > 0)
      );

      CREATE TABLE dig_record (
        id TEXT PRIMARY KEY,
        blast_id TEXT NOT NULL REFERENCES blast(id) ON DELETE CASCADE,
        recorded_on TEXT NOT NULL,
        loader TEXT,
        buckets INTEGER,
        tonnes REAL NOT NULL,
        hours REAL NOT NULL,
        delay_minutes REAL NOT NULL DEFAULT 0,
        delay_reason TEXT,
        created_at TEXT NOT NULL,
        CHECK (tonnes >= 0),
        CHECK (hours > 0),
        CHECK (delay_minutes >= 0)
      );

      CREATE TABLE secondary_breaking (
        id TEXT PRIMARY KEY,
        blast_id TEXT NOT NULL REFERENCES blast(id) ON DELETE CASCADE,
        carried_out_on TEXT NOT NULL,
        method TEXT NOT NULL,
        boulder_count INTEGER NOT NULL DEFAULT 0,
        hours REAL NOT NULL DEFAULT 0,
        explosive_used_kg REAL,
        carried_out_by TEXT REFERENCES person(id),
        note TEXT,
        created_at TEXT NOT NULL,
        CHECK (method IN ('hydraulic_hammer', 'pop_shooting', 'plaster_shooting', 'drop_ball')),
        CHECK (boulder_count >= 0),
        CHECK (hours >= 0)
      );

      CREATE TABLE supply_order (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
        supplier TEXT NOT NULL,
        reference TEXT NOT NULL,
        placed_at TEXT NOT NULL,
        placed_by TEXT REFERENCES person(id),
        expected_on TEXT,
        state TEXT NOT NULL DEFAULT 'placed',
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (site_id, reference),
        CHECK (state IN ('draft', 'placed', 'part_delivered', 'delivered', 'cancelled'))
      );

      CREATE TABLE supply_order_line (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES supply_order(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
        quantity REAL NOT NULL,
        unit TEXT NOT NULL,
        delivered_quantity REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        CHECK (quantity > 0),
        CHECK (delivered_quantity >= 0),
        CHECK (unit IN ('kg', 'each', 'metre'))
      );

      CREATE TABLE drill_rig (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
        fleet_number TEXT NOT NULL,
        make TEXT,
        model TEXT,
        hole_diameter_min_mm REAL NOT NULL,
        hole_diameter_max_mm REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'available',
        hours_run REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (site_id, fleet_number),
        CHECK (hole_diameter_max_mm >= hole_diameter_min_mm),
        CHECK (status IN ('available', 'drilling', 'maintenance', 'down', 'retired')),
        CHECK (hours_run >= 0)
      );

      CREATE TABLE drill_shift (
        id TEXT PRIMARY KEY,
        rig_id TEXT NOT NULL REFERENCES drill_rig(id) ON DELETE CASCADE,
        pattern_id TEXT REFERENCES pattern(id) ON DELETE SET NULL,
        shift_date TEXT NOT NULL,
        shift TEXT NOT NULL,
        operator_id TEXT REFERENCES person(id),
        metres_drilled REAL NOT NULL DEFAULT 0,
        holes_drilled INTEGER NOT NULL DEFAULT 0,
        hours REAL NOT NULL,
        downtime_minutes REAL NOT NULL DEFAULT 0,
        downtime_reason TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (rig_id, shift_date, shift),
        CHECK (shift IN ('day', 'back', 'night')),
        CHECK (metres_drilled >= 0),
        CHECK (hours > 0),
        CHECK (downtime_minutes >= 0)
      );

      CREATE INDEX survey_by_blast ON survey (blast_id, surveyed_at);
      CREATE INDEX dig_by_blast ON dig_record (blast_id, recorded_on);
      CREATE INDEX breaking_by_blast ON secondary_breaking (blast_id);
      CREATE INDEX order_by_site ON supply_order (site_id, state);
      CREATE INDEX line_by_order ON supply_order_line (order_id);
      CREATE INDEX shift_by_rig ON drill_shift (rig_id, shift_date);
      CREATE INDEX shift_by_pattern ON drill_shift (pattern_id);
    `);
  },
};

export default migration;
