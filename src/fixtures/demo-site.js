/**
 * A quarry to try things against.
 *
 * Used by the seed command and by the tests that need a whole site rather than
 * one table. The numbers are a real bench: fifteen metres, dolerite, a hundred
 * and two millimetre holes, a cottage two hundred metres east and a listed
 * church further out. The site law is one fitted from a real run of records, so
 * predictions off it land where a designer would expect.
 */

import { createSite, createBench } from '../db/repositories/sites.js';
import { createPattern, replaceHoles, recordDrilling } from '../db/repositories/patterns.js';
import {
  createProduct,
  findProductByCode,
  createMagazine,
  createBatch,
  recordMovement,
} from '../db/repositories/explosives.js';
import { createReceptor, saveSiteLaw } from '../db/repositories/monitoring.js';
import { insertRow } from '../db/repository.js';
import { layoutPattern } from '../domain/geometry/pattern.js';
import { createRandom } from '../lib/random.js';

export const DEMO_PEOPLE = [
  { id: 'per_demo_manager', name: 'A Whelan', roles: 'manager' },
  { id: 'per_demo_designer', name: 'K Barrett', roles: 'designer' },
  { id: 'per_demo_shotfirer', name: 'M Cronin', roles: 'shotfirer' },
  { id: 'per_demo_store', name: 'S Nolan', roles: 'store' },
];

/** Products are shared across sites, so a second quarry reuses what is there. */
function ensureProduct(db, input, context) {
  return findProductByCode(db, input.code) ?? createProduct(db, input, context);
}

export function seedDemoSite(db, { clock, code = 'MDW', seed = 20251027 } = {}) {
  const context = { clock };
  const now = clock.now();
  const random = createRandom(seed);

  // Identifiers carry the site code so that seeding a second demonstration
  // quarry into the same database does not collide with the first.
  const suffix = code.toLowerCase();
  const people = DEMO_PEOPLE.map((person) => ({ ...person, id: `${person.id}_${suffix}` }));
  for (const person of people) {
    insertRow(db, 'person', { ...person, createdAt: now, updatedAt: now });
  }
  insertRow(db, 'certificate', {
    id: `cert_demo_${suffix}`,
    personId: `per_demo_shotfirer_${suffix}`,
    kind: 'shotfirer',
    reference: 'SF-2201',
    issuedOn: '2023-01-15',
    expiresOn: '2028-01-15',
    endorsements: 'bulk_explosive,shock_tube_initiation',
    createdAt: now,
    updatedAt: now,
  });

  const site = createSite(
    db,
    { code, name: 'Midway Quarry', timeZone: 'Europe/Dublin', licenceNumber: 'EL-4471' },
    context,
  );
  const bench = createBench(
    db,
    {
      siteId: site.id,
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
      ucsMpa: 180,
    },
    context,
  );

  const pattern = createPattern(
    db,
    {
      benchId: bench.id,
      reference: `${code}-2025-014`,
      layout: 'staggered',
      holeDiameterMm: 102,
      nominalBurdenM: 3,
      nominalSpacingM: 3.5,
      rowCount: 3,
      holesPerRow: 8,
      benchHeightM: 15,
      subdrillM: 1,
      inclinationDeg: 10,
      bearingDeg: 0,
      designedBy: `per_demo_designer_${suffix}`,
    },
    context,
  );
  const laid = layoutPattern({
    origin: { easting: 1000, northing: 2000, level: 84 },
    faceBearingDeg: 0,
    layout: 'staggered',
    rowCount: 3,
    holesPerRow: 8,
    burdenM: 3,
    spacingM: 3.5,
    benchHeightM: 15,
    subdrillM: 1,
    inclinationDeg: 10,
    diameterMm: 102,
  });
  replaceHoles(db, pattern.id, laid.holes, context);
  recordDrilling(
    db,
    pattern.id,
    laid.holes.map((hole) => ({
      holeNumber: hole.holeNumber,
      drilledDepthM: Number((hole.designedDepthM + random.between(-0.2, 0.3)).toFixed(2)),
      condition: hole.holeNumber % 7 === 0 ? 'wet' : 'dry',
      waterDepthM: hole.holeNumber % 7 === 0 ? 3.2 : null,
    })),
    context,
  );

  const anfo = ensureProduct(
    db,
    {
      code: 'ANFO-80',
      name: 'Ammonium nitrate fuel oil, poured',
      kind: 'bulk_anfo',
      densityKgM3: 800,
      relativeWeightStrength: 100,
      velocityOfDetonationMs: 3200,
      waterResistance: 'none',
      minimumDiameterMm: 50,
      unNumber: 'UN0331',
      hazardDivision: '1.5D',
      compatibilityGroup: 'D',
    },
    context,
  );
  const emulsion = ensureProduct(
    db,
    {
      code: 'EM-115',
      name: 'Pumped emulsion, gassed',
      kind: 'bulk_emulsion',
      densityKgM3: 1150,
      relativeWeightStrength: 82,
      velocityOfDetonationMs: 5200,
      waterResistance: 'excellent',
      minimumDiameterMm: 76,
      sleepTimeHours: 72,
      unNumber: 'UN0241',
      hazardDivision: '1.5D',
      compatibilityGroup: 'D',
    },
    context,
  );
  ensureProduct(
    db,
    {
      code: 'BST-400',
      name: 'Cast pentolite booster 400 g',
      kind: 'booster',
      unitMassKg: 0.4,
      velocityOfDetonationMs: 7400,
      waterResistance: 'excellent',
      unNumber: 'UN0042',
      hazardDivision: '1.1D',
      compatibilityGroup: 'D',
    },
    context,
  );

  const magazine = createMagazine(
    db,
    {
      siteId: site.id,
      name: 'Upper store',
      licenceNumber: 'MAG-1188',
      netExplosiveLimitKg: 4000,
      eastingM: 700,
      northingM: 2400,
    },
    context,
  );
  for (const [product, quantity, batchCode] of [
    [anfo, 2000, `L2025-114-${suffix}`],
    [emulsion, 1200, `E2025-77-${suffix}`],
  ]) {
    const batch = createBatch(
      db,
      {
        productId: product.id,
        batchCode,
        manufacturedOn: '2025-04-01',
        expiresOn: '2026-04-01',
        supplier: 'Kilcorney Explosives',
        deliveryNote: `DN-${batchCode}`,
      },
      context,
    );
    recordMovement(
      db,
      {
        magazineId: magazine.id,
        batchId: batch.id,
        movement: 'receipt',
        quantity,
        massKg: quantity,
        personId: `per_demo_store_${suffix}`,
        reference: `DN-${batchCode}`,
      },
      context,
    );
  }

  const receptors = [
    {
      name: 'Keeper cottage',
      structureClass: 'older_dwelling',
      easting: 1400,
      northing: 2000,
      monitored: true,
      notifiable: true,
      typicalFrequencyHz: 18,
    },
    {
      name: 'Saint Brendan church',
      structureClass: 'listed',
      easting: 1000,
      northing: 2900,
      notifiable: true,
    },
    {
      name: 'Council depot',
      structureClass: 'commercial',
      easting: 1800,
      northing: 1700,
      occupied: false,
    },
    {
      name: 'Gas main crossing',
      structureClass: 'buried_service',
      easting: 900,
      northing: 2500,
      occupied: false,
      limitMmPerSecond: 25,
    },
  ].map((receptor) => createReceptor(db, { ...receptor, siteId: site.id }, context));

  const law = saveSiteLaw(
    db,
    {
      siteId: site.id,
      k: 1140,
      b: 1.6,
      scaling: 'square_root',
      recordCount: 42,
      rSquared: 0.88,
      residualStandardError: 0.11,
    },
    context,
  );

  return { site, bench, pattern, holes: laid.holes, magazine, receptors, law, people };
}
