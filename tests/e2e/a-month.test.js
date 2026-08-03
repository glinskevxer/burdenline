/**
 * A month at a quarry.
 *
 * Two shots, an order that arrives between them, a complaint after the second,
 * and the month end reports read off the lot. The point of this one is not any
 * single route: it is that the numbers agree with each other at the end of a
 * month's ordinary work, which is the only test that would catch a report
 * quietly counting something twice.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from '../http/helpers.js';
import { importRecords, saveSiteLaw } from '../../src/db/repositories/monitoring.js';
import { parseRecord } from '../../src/domain/monitoring/records.js';
import { setPrice, setRate } from '../../src/db/repositories/costing.js';
import { findProductByCode } from '../../src/db/repositories/explosives.js';

let harness;
let siteId;
let benchId;
let magazineId;
let receptorId;

const at = '2026-08-03T09:00:00.000Z';

function ok(response, code = 200) {
  if (response.statusCode !== code) {
    throw new Error(`expected ${code}, got ${response.statusCode}: ${response.payload}`);
  }
  return response.json();
}

async function layPattern(reference, easting) {
  return ok(
    await harness.post(`/benches/${benchId}/patterns`, 'designer', {
      reference,
      origin: { easting, northing: 2000, level: 84 },
      faceBearingDeg: 0,
      layout: 'staggered',
      rowCount: 2,
      holesPerRow: 6,
      burdenM: 3,
      spacingM: 3.5,
      subdrillM: 1,
      diameterMm: 102,
    }),
    201,
  ).pattern;
}

async function fireShot({ reference, pattern, firedAt, issueKg }) {
  const blast = ok(
    await harness.post(`/sites/${siteId}/blasts`, 'designer', { reference, patternId: pattern.id }),
    201,
  ).blast;
  const csv = [
    'hole,depth',
    ...Array.from({ length: 12 }, (_unused, index) => `${index + 1},16`),
  ].join('\n');
  ok(await harness.post(`/patterns/${pattern.id}/drill-log`, 'designer', { csv }));
  ok(
    await harness.put(`/blasts/${blast.id}/totals`, 'designer', {
      volumeM3: 1890,
      holeCount: 12,
      totalChargeKg: issueKg,
      instantaneousChargeKg: 86,
    }),
  );
  ok(await harness.post(`/blasts/${blast.id}/complete-design`, 'designer'));
  ok(await harness.post(`/blasts/${blast.id}/submit`, 'designer'));
  ok(await harness.post(`/blasts/${blast.id}/approve`, 'manager'));
  ok(
    await harness.post(`/blasts/${blast.id}/issues`, 'store', {
      magazineId,
      items: [{ productCode: 'ANFO-80', quantity: issueKg }],
    }),
    201,
  );
  harness.db
    .prepare("UPDATE blast SET state = 'fired', fired_at = ? WHERE id = ?")
    .run(firedAt, blast.id);
  ok(
    await harness.post(`/blasts/${blast.id}/inspection`, 'shotfirer', {
      muckpileShape: 'moderate',
      throwM: 12,
      toeGrade: 'none',
      oversizeCount: 5,
      inspectedAt: firedAt,
    }),
    201,
  );
  ok(
    await harness.post(`/blasts/${blast.id}/surveys`, 'designer', {
      method: 'laser_scan',
      volumeM3: 1950,
      surveyedAt: firedAt,
    }),
    201,
  );
  ok(
    await harness.post(`/blasts/${blast.id}/dig-records`, 'viewer', { tonnes: 5200, hours: 10 }),
    201,
  );
  return blast;
}

beforeEach(async () => {
  harness = await standUp({ at });
  siteId = ok(
    await harness.post('/sites', 'admin', {
      code: 'MDW',
      name: 'Midway Quarry',
      licenceNumber: 'EL-4471',
      timeZone: 'Europe/Dublin',
    }),
    201,
  ).site.id;
  benchId = ok(
    await harness.post(`/sites/${siteId}/benches`, 'designer', {
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
    }),
    201,
  ).bench.id;
  receptorId = ok(
    await harness.post(`/sites/${siteId}/receptors`, 'admin', {
      name: 'Keeper cottage',
      structureClass: 'older_dwelling',
      easting: 1600,
      northing: 2000,
      monitored: true,
    }),
    201,
  ).receptor.id;
  ok(
    await harness.post('/products', 'admin', {
      code: 'ANFO-80',
      name: 'Ammonium nitrate fuel oil',
      kind: 'bulk_anfo',
      densityKgM3: 800,
      relativeWeightStrength: 100,
      minimumDiameterMm: 50,
    }),
    201,
  );
  magazineId = ok(
    await harness.post(`/sites/${siteId}/magazines`, 'admin', {
      name: 'Upper store',
      netExplosiveLimitKg: 8000,
    }),
    201,
  ).magazine.id;
  const batch = ok(
    await harness.post(
      `/products/${findProductByCode(harness.db, 'ANFO-80').id}/batches`,
      'store',
      { batchCode: 'L2026-200', expiresOn: '2027-08-01' },
    ),
    201,
  ).batch;
  ok(
    await harness.post(`/magazines/${magazineId}/movements`, 'store', {
      batchId: batch.id,
      movement: 'receipt',
      quantity: 3000,
      massKg: 3000,
    }),
    201,
  );
  saveSiteLaw(harness.db, { siteId, k: 1140, b: 1.6, recordCount: 40 }, { clock: harness.clock });
  setPrice(
    harness.db,
    {
      productId: findProductByCode(harness.db, 'ANFO-80').id,
      pricePerUnit: 1.25,
      effectiveFrom: '2026-01-01',
    },
    { clock: harness.clock },
  );
  setRate(
    harness.db,
    { siteId, kind: 'drilling', rate: 6.8, unit: 'metre', effectiveFrom: '2026-01-01' },
    { clock: harness.clock },
  );
});

afterEach(async () => {
  await harness.close();
});

describe('a month of ordinary work', () => {
  it('leaves every report agreeing with every other', async () => {
    const first = await fireShot({
      reference: 'MDW-2026-201',
      pattern: await layPattern('MDW-2026-201-P', 1000),
      firedAt: '2026-08-11T13:00:00.000Z',
      issueKg: 1000,
    });

    // Stock is topped up between the two shots.
    const order = ok(
      await harness.post(`/sites/${siteId}/orders`, 'store', {
        supplier: 'Kilcorney Explosives',
        reference: 'PO-2026-200',
        lines: [{ productCode: 'ANFO-80', quantity: 2000 }],
      }),
      201,
    ).order;
    ok(
      await harness.post(`/orders/${order.id}/deliveries`, 'store', {
        magazineId,
        deliveryNote: 'DN-7001',
        items: [{ productCode: 'ANFO-80', quantity: 2000, batchCode: 'L2026-214' }],
      }),
      201,
    );

    const second = await fireShot({
      reference: 'MDW-2026-202',
      pattern: await layPattern('MDW-2026-202-P', 1040),
      firedAt: '2026-08-25T13:00:00.000Z',
      issueKg: 1100,
    });

    // A monitor record and a complaint after the second shot.
    importRecords(
      harness.db,
      siteId,
      [
        parseRecord({
          monitorSerial: 'BE-11482',
          receptorId,
          triggeredAt: '2026-08-25T13:00:05.000Z',
          distanceM: 600,
          longitudinal: { peakMmPerSecond: 2.1, frequencyHz: 20 },
          transverse: { peakMmPerSecond: 3.4, frequencyHz: 18 },
          vertical: { peakMmPerSecond: 1.7, frequencyHz: 24 },
          airblastDb: 111.8,
        }),
      ],
      { clock: harness.clock },
    );
    ok(
      await harness.post(`/sites/${siteId}/complaints`, 'viewer', {
        channel: 'telephone',
        about: 'vibration',
        receptorId,
        blastId: second.id,
        occurredAt: '2026-08-25T13:00:00.000Z',
        receivedAt: '2026-08-26T09:00:00.000Z',
        description: 'the windows rattled just after two yesterday afternoon',
      }),
      201,
    );

    const month = 'from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:00.000Z';

    // The stock: three thousand in, two thousand more in, two thousand one hundred out.
    const stock = ok(await harness.get(`/magazines/${magazineId}/stock`, 'store')).stock;
    expect(stock.netExplosiveKg).toBe(2900);

    // The month, the productivity and the pack all count the same two shots.
    const period = ok(await harness.get(`/sites/${siteId}/report?${month}`, 'manager'));
    const productivity = ok(await harness.get(`/sites/${siteId}/productivity?${month}`, 'manager'));
    const pack = ok(await harness.get(`/sites/${siteId}/regulator-pack?${month}`, 'manager')).pack;
    expect(period.blastCount).toBe(2);
    expect(productivity.blastCount).toBe(2);
    expect(pack.blasting.count).toBe(2);

    // And the same explosive, whichever report is asked.
    expect(pack.blasting.totalChargeKg).toBe(2100);
    expect(productivity.explosiveKg).toBe(2100);
    expect(period.chargeKg).toBe(2100);

    // The drilling is counted once, not once per report.
    expect(productivity.metresDrilled).toBe(384);
    expect(period.metresDrilled).toBe(384);

    // The complaint and the reading turn up in the return.
    expect(pack.complaints.count).toBe(1);
    expect(pack.vibration.highest).toBe(3.4);
    expect(pack.summary.compliant).toBe(true);

    // The scorecard is clean apart from the complaint still being open.
    const card = ok(await harness.get(`/sites/${siteId}/scorecard?${month}`, 'manager'));
    expect(card.tonnes).toBeGreaterThan(10000);
    expect(card.costPerTonne).toBeGreaterThan(0);

    // And the first shot's own report still adds up on its own.
    const shotReport = ok(await harness.get(`/blasts/${first.id}/report`, 'manager'));
    expect(shotReport.metresDrilled).toBe(192);
    expect(shotReport.cost.parts.explosive).toBe(1250);
    expect(shotReport.diggable).toBe(true);
  });
});
