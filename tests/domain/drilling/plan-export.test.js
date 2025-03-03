import { describe, it, expect } from 'vitest';
import {
  holeIdentifier,
  buildPlanRows,
  exportDrillPlan,
  planSummary,
  PLAN_FORMATS,
} from '../../../src/domain/drilling/plan-export.js';
import { parseCsvRecords } from '../../../src/lib/csv.js';
import { layoutPattern } from '../../../src/domain/geometry/pattern.js';
import { ValidationError } from '../../../src/lib/errors.js';

const design = {
  origin: { easting: 1000, northing: 2000, level: 84 },
  faceBearingDeg: 0,
  layout: 'square',
  rowCount: 2,
  holesPerRow: 3,
  burdenM: 3,
  spacingM: 3.5,
  benchHeightM: 15,
  subdrillM: 1,
  inclinationDeg: 0,
  diameterMm: 102,
};

const pattern = {
  reference: 'MDW-2025-014',
  benchHeightM: 15,
  subdrillM: 1,
};

const holes = layoutPattern(design).holes;

describe('holeIdentifier', () => {
  it('fits inside what the rig will display', () => {
    expect(holeIdentifier('MDW-2025-014', 7).length).toBeLessThanOrEqual(12);
  });

  it('keeps the end of the reference, which is what varies', () => {
    expect(holeIdentifier('MDW-2025-014', 7)).toBe('W2025014-007');
  });

  it('pads the hole number so the rig sorts them', () => {
    expect(holeIdentifier('MDW-2025-014', 7).endsWith('-007')).toBe(true);
    expect(holeIdentifier('MDW-2025-014', 112).endsWith('-112')).toBe(true);
  });
});

describe('buildPlanRows', () => {
  it('writes one row per hole', () => {
    expect(buildPlanRows(pattern, holes)).toHaveLength(6);
  });

  it('rounds coordinates to the centimetre the rig can hold', () => {
    const rows = buildPlanRows(pattern, holes);
    for (const row of rows) {
      expect(row.easting).toBe(Number(row.easting.toFixed(2)));
    }
  });

  it('leaves the toe out of the collar format and puts it in the other', () => {
    expect(buildPlanRows(pattern, holes)[0]).not.toHaveProperty('toe_level');
    const withToe = buildPlanRows(pattern, holes, { format: 'collar_toe' })[0];
    expect(withToe.toe_level).toBe(68);
  });

  it('walks an angled hole toe out in front of the collar', () => {
    const angled = layoutPattern({ ...design, inclinationDeg: 15 }).holes;
    const row = buildPlanRows(pattern, angled, { format: 'collar_toe' })[0];
    expect(row.toe_easting).not.toBe(row.easting);
  });

  it('refuses a format nothing on site reads', () => {
    expect(() => buildPlanRows(pattern, holes, { format: 'dxf' })).toThrow(ValidationError);
  });

  it('refuses an empty pattern', () => {
    expect(() => buildPlanRows(pattern, [])).toThrow(/at least one hole/);
  });

  it('refuses to send two holes under the same identifier', () => {
    const duplicated = [holes[0], { ...holes[1], holeNumber: holes[0].holeNumber }];
    expect(() => buildPlanRows(pattern, duplicated)).toThrow(/would be sent to the rig as/);
  });
});

describe('exportDrillPlan', () => {
  it('writes the columns in the order the rig expects', () => {
    const csv = exportDrillPlan(pattern, holes);
    expect(csv.split('\r\n')[0]).toBe(
      'id,hole,row,easting,northing,level,depth,diameter,inclination,bearing',
    );
  });

  it('ends its lines the way the rig wants them', () => {
    expect(exportDrillPlan(pattern, holes)).toContain('\r\n');
  });

  it('round trips back through the parser', () => {
    const { records } = parseCsvRecords(exportDrillPlan(pattern, holes));
    expect(records).toHaveLength(6);
    expect(records[0].depth).toBe('16');
  });

  it('writes the wider file for the other rig', () => {
    const csv = exportDrillPlan(pattern, holes, { format: 'collar_toe' });
    expect(csv.split('\r\n')[0]).toContain('toe_easting');
  });
});

describe('planSummary', () => {
  it('adds up what the crew is being asked to drill', () => {
    expect(planSummary(pattern, holes)).toEqual({
      reference: 'MDW-2025-014',
      holeCount: 6,
      rowCount: 2,
      totalDrillingM: 96,
      averageDepthM: 16,
      diametersMm: [102],
      mixedDiameters: false,
    });
  });

  it('flags a pattern drilled at two diameters', () => {
    const mixed = holes.map((hole, index) => (index === 0 ? { ...hole, diameterMm: 89 } : hole));
    const summary = planSummary(pattern, mixed);
    expect(summary.diametersMm).toEqual([89, 102]);
    expect(summary.mixedDiameters).toBe(true);
  });
});

describe('the format vocabulary', () => {
  it('names both rigs on site', () => {
    expect(PLAN_FORMATS).toEqual(['collar', 'collar_toe']);
  });
});
