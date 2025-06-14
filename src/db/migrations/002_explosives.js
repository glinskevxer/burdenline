/**
 * Explosives: the catalogue, the batches, the magazines they sit in and the
 * ledger of everything that moved.
 *
 * The ledger is append only and it is the legal record. Nothing updates a
 * quantity in place: a correction is another line with a reason, so that the
 * day-book can always be rebuilt from the ledger and the two can be reconciled
 * against each other. A magazine licence caps the net explosive quantity that
 * may be held, and it is held on the magazine rather than in configuration
 * because two magazines on the same site have different limits.
 */

export const migration = {
  id: '002',
  name: 'explosives and magazines',
  up(db) {
    db.exec(`
      CREATE TABLE product (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        density_kg_m3 REAL,
        relative_weight_strength REAL,
        velocity_of_detonation_ms REAL,
        water_resistance TEXT NOT NULL DEFAULT 'none',
        minimum_diameter_mm REAL,
        sleep_time_hours INTEGER,
        un_number TEXT,
        hazard_division TEXT,
        compatibility_group TEXT,
        unit_mass_kg REAL,
        is_explosive INTEGER NOT NULL DEFAULT 1,
        retired_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (kind IN ('bulk_anfo', 'bulk_emulsion', 'bulk_blend', 'packaged_emulsion',
                        'cartridge', 'booster', 'detonator', 'detonating_cord', 'shock_tube')),
        CHECK (water_resistance IN ('none', 'limited', 'good', 'excellent')),
        CHECK (density_kg_m3 IS NULL OR density_kg_m3 BETWEEN 200 AND 2000),
        CHECK (un_number IS NULL OR un_number GLOB 'UN[0-9][0-9][0-9][0-9]'),
        CHECK (is_explosive IN (0, 1))
      );

      CREATE TABLE magazine (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        licence_number TEXT,
        kind TEXT NOT NULL DEFAULT 'store',
        net_explosive_limit_kg REAL NOT NULL,
        detonator_limit INTEGER,
        easting_m REAL,
        northing_m REAL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (site_id, name),
        CHECK (kind IN ('store', 'detonator_store', 'day_box', 'mobile_unit')),
        CHECK (net_explosive_limit_kg > 0),
        CHECK (detonator_limit IS NULL OR detonator_limit > 0),
        CHECK (status IN ('active', 'closed', 'suspended'))
      );

      CREATE TABLE product_batch (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
        batch_code TEXT NOT NULL,
        manufactured_on TEXT,
        expires_on TEXT,
        received_at TEXT NOT NULL,
        supplier TEXT,
        delivery_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (product_id, batch_code),
        CHECK (expires_on IS NULL OR manufactured_on IS NULL OR expires_on > manufactured_on)
      );

      CREATE TABLE magazine_ledger (
        id TEXT PRIMARY KEY,
        magazine_id TEXT NOT NULL REFERENCES magazine(id) ON DELETE RESTRICT,
        batch_id TEXT NOT NULL REFERENCES product_batch(id) ON DELETE RESTRICT,
        movement TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit TEXT NOT NULL,
        mass_kg REAL NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        person_id TEXT,
        blast_id TEXT,
        reference TEXT,
        reason TEXT,
        corrects_id TEXT REFERENCES magazine_ledger(id),
        created_at TEXT NOT NULL,
        CHECK (movement IN ('receipt', 'issue', 'return', 'consumption', 'disposal',
                            'transfer_in', 'transfer_out', 'correction', 'stocktake')),
        CHECK (unit IN ('kg', 'each', 'metre')),
        CHECK (quantity <> 0)
      );

      CREATE TABLE daybook_entry (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
        entry_date TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        magazine_id TEXT REFERENCES magazine(id),
        movement TEXT NOT NULL,
        product_code TEXT NOT NULL,
        batch_code TEXT,
        quantity REAL NOT NULL,
        unit TEXT NOT NULL,
        balance_after REAL NOT NULL,
        person_name TEXT NOT NULL,
        signature TEXT,
        ledger_id TEXT REFERENCES magazine_ledger(id),
        created_at TEXT NOT NULL,
        UNIQUE (site_id, entry_date, sequence),
        CHECK (sequence > 0)
      );

      CREATE INDEX ledger_by_magazine ON magazine_ledger (magazine_id, occurred_at);
      CREATE INDEX ledger_by_batch ON magazine_ledger (batch_id, occurred_at);
      CREATE INDEX ledger_by_blast ON magazine_ledger (blast_id);
      CREATE INDEX batch_by_product ON product_batch (product_id, expires_on);
      CREATE INDEX daybook_by_date ON daybook_entry (site_id, entry_date, sequence);
    `);
  },
};

export default migration;
