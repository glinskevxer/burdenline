/**
 * The geometry core: where the quarry is, which bench is being shot, the pattern
 * drilled into it and every hole in that pattern.
 *
 * Coordinates are site grid metres, not latitude and longitude. Every quarry
 * survey this system has to read speaks in a local grid, and converting to a
 * geographic frame and back loses the millimetres that the burden calculation
 * cares about.
 */

export const migration = {
  id: '001',
  name: 'core geometry',
  up(db) {
    db.exec(`
      CREATE TABLE site (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        time_zone TEXT NOT NULL DEFAULT 'UTC',
        licence_number TEXT,
        grid_epsg INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (length(code) BETWEEN 2 AND 4),
        CHECK (code = upper(code))
      );

      CREATE TABLE bench (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        crest_level_m REAL NOT NULL,
        toe_level_m REAL NOT NULL,
        rock_type TEXT NOT NULL,
        rock_density_kg_m3 REAL NOT NULL,
        ucs_mpa REAL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (site_id, name),
        CHECK (crest_level_m > toe_level_m),
        CHECK (rock_density_kg_m3 BETWEEN 1200 AND 4500),
        CHECK (ucs_mpa IS NULL OR ucs_mpa > 0),
        CHECK (status IN ('active', 'worked_out', 'suspended'))
      );

      CREATE TABLE pattern (
        id TEXT PRIMARY KEY,
        bench_id TEXT NOT NULL REFERENCES bench(id) ON DELETE CASCADE,
        reference TEXT NOT NULL UNIQUE,
        layout TEXT NOT NULL DEFAULT 'staggered',
        hole_diameter_mm REAL NOT NULL,
        nominal_burden_m REAL NOT NULL,
        nominal_spacing_m REAL NOT NULL,
        row_count INTEGER NOT NULL,
        holes_per_row INTEGER NOT NULL,
        bench_height_m REAL NOT NULL,
        subdrill_m REAL NOT NULL DEFAULT 0,
        inclination_deg REAL NOT NULL DEFAULT 0,
        bearing_deg REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        designed_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (layout IN ('square', 'staggered', 'single_row')),
        CHECK (hole_diameter_mm BETWEEN 25 AND 400),
        CHECK (nominal_burden_m > 0 AND nominal_spacing_m > 0),
        CHECK (row_count > 0 AND holes_per_row > 0),
        CHECK (bench_height_m > 0),
        CHECK (subdrill_m >= 0),
        CHECK (inclination_deg BETWEEN 0 AND 45),
        CHECK (bearing_deg >= 0 AND bearing_deg < 360),
        CHECK (status IN ('draft', 'marked_out', 'drilled', 'loaded', 'fired', 'abandoned'))
      );

      CREATE TABLE hole (
        id TEXT PRIMARY KEY,
        pattern_id TEXT NOT NULL REFERENCES pattern(id) ON DELETE CASCADE,
        hole_number INTEGER NOT NULL,
        row_number INTEGER NOT NULL,
        easting_m REAL NOT NULL,
        northing_m REAL NOT NULL,
        collar_level_m REAL NOT NULL,
        designed_depth_m REAL NOT NULL,
        drilled_depth_m REAL,
        diameter_mm REAL NOT NULL,
        inclination_deg REAL NOT NULL DEFAULT 0,
        bearing_deg REAL NOT NULL DEFAULT 0,
        condition TEXT NOT NULL DEFAULT 'dry',
        water_depth_m REAL,
        status TEXT NOT NULL DEFAULT 'planned',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (pattern_id, hole_number),
        CHECK (hole_number > 0 AND row_number > 0),
        CHECK (designed_depth_m > 0),
        CHECK (drilled_depth_m IS NULL OR drilled_depth_m > 0),
        CHECK (diameter_mm BETWEEN 25 AND 400),
        CHECK (condition IN ('dry', 'damp', 'wet', 'cavity', 'collapsed', 'lost')),
        CHECK (water_depth_m IS NULL OR water_depth_m >= 0),
        CHECK (status IN ('planned', 'drilled', 'redrill', 'charged', 'fired', 'abandoned'))
      );

      CREATE INDEX bench_by_site ON bench (site_id, status);
      CREATE INDEX pattern_by_bench ON pattern (bench_id, status);
      CREATE INDEX hole_by_pattern ON hole (pattern_id, hole_number);
      CREATE INDEX hole_by_status ON hole (pattern_id, status);
    `);
  },
};

export default migration;
