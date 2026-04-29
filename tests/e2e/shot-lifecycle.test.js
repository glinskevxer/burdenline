/**
 * One shot, end to end, over HTTP.
 *
 * This is the test that would have caught every integration bug the unit tests
 * missed: it stands the whole server up, walks a blast from an empty database to
 * a regulator return, and checks the numbers that come out the far end against
 * the ones that went in. Nothing is stubbed. If a repository stops writing a
 * field the design service reads, this fails and the unit tests do not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from '../http/helpers.js';
import { insertRow } from '../../src/db/repository.js';

let harness;
const at = '2026-03-03T13:00:00.000Z';

async function post(url, role, payload) {
  const response = await harness.app.inject({
    method: 'POST',
    url,
    headers: harness.as(role),
    ...(payload !== undefined ? { payload } : {}),
  });
  return response;
}

function expectOk(response, code = 200) {
  if (response.statusCode !== code) {
    throw new Error(`${response.statusCode} from the last call: ${response.payload}`);
  }
  return response.json();
}

beforeEach(async () => {
  harness = await standUp({ at });
  insertRow(harness.db, 'certificate', {
    id: 'cert_1',
    personId: 'per_shotfirer',
    kind: 'shotfirer',
    issuedOn: '2024-01-15',
    expiresOn: '2029-01-15',
    endorsements: 'bulk_explosive,shock_tube_initiation',
    createdAt: at,
    updatedAt: at,
  });
});

afterEach(async () => {
  await harness.close();
});

describe('a shot from an empty database to a regulator return', () => {
  it('walks the whole way', async () => {
    // The quarry, its bench and the house down the road.
    const site = expectOk(
      await post('/sites', 'admin', {
        code: 'MDW',
        name: 'Midway Quarry',
        timeZone: 'Europe/Dublin',
        licenceNumber: 'EL-4471',
      }),
      201,
    ).site;
    const bench = expectOk(
      await post(`/sites/${site.id}/benches`, 'designer', {
        name: 'North 60',
        crestLevelM: 84,
        toeLevelM: 69,
        rockType: 'dolerite',
        rockDensityKgM3: 2900,
      }),
      201,
    ).bench;
    expect(bench.heightM).toBe(15);

    expectOk(
      await post(`/sites/${site.id}/receptors`, 'admin', {
        name: 'Keeper cottage',
        structureClass: 'older_dwelling',
        easting: 1400,
        northing: 2000,
        monitored: true,
        notifiable: true,
      }),
      201,
    );

    // The explosive it will be loaded with, and the stock to load it from.
    const product = expectOk(
      await post('/products', 'admin', {
        code: 'ANFO-80',
        name: 'Ammonium nitrate fuel oil',
        kind: 'bulk_anfo',
        densityKgM3: 800,
        relativeWeightStrength: 100,
        minimumDiameterMm: 50,
      }),
      201,
    ).product;
    const magazine = expectOk(
      await post(`/sites/${site.id}/magazines`, 'admin', {
        name: 'Upper store',
        netExplosiveLimitKg: 4000,
      }),
      201,
    ).magazine;
    const batch = expectOk(
      await post(`/products/${product.id}/batches`, 'store', {
        batchCode: 'L2026-014',
        expiresOn: '2027-06-01',
        supplier: 'Kilcorney Explosives',
      }),
      201,
    ).batch;
    expectOk(
      await post(`/magazines/${magazine.id}/movements`, 'store', {
        batchId: batch.id,
        movement: 'receipt',
        quantity: 2000,
        massKg: 2000,
        reference: 'DN-88213',
      }),
      201,
    );

    // A site law to design against, and the pattern itself.
    harness.db
      .prepare(
        `INSERT INTO site_law (id, site_id, k, b, scaling, record_count, fitted_at, created_at)
         VALUES ('law_1', ?, 1140, 1.6, 'square_root', 42, ?, ?)`,
      )
      .run(site.id, at, at);

    const pattern = expectOk(
      await post(`/benches/${bench.id}/patterns`, 'designer', {
        reference: 'MDW-2026-014',
        origin: { easting: 1000, northing: 2000, level: 84 },
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
    );
    expect(pattern.holeCount).toBe(12);

    // The rig drills it and reports back.
    const drillLog = [
      'Hole,Depth (m),Condition',
      ...Array.from({ length: 12 }, (_unused, index) => `${index + 1},16.0,dry`),
    ].join('\n');
    const drilled = expectOk(
      await post(`/patterns/${pattern.pattern.id}/drill-log`, 'designer', { csv: drillLog }),
    );
    expect(drilled.written.updated).toBe(12);
    expect(drilled.reconciliation.ready).toBe(true);

    // The design: charge, tie-in, vibration.
    const blast = expectOk(
      await post(`/sites/${site.id}/blasts`, 'designer', {
        reference: 'MDW-2026-014',
        patternId: pattern.pattern.id,
      }),
      201,
    ).blast;

    const tieIn = {
      initiationHole: 1,
      holes: Array.from({ length: 12 }, (_unused, index) => ({
        holeNumber: index + 1,
        inHoleDelayMs: 500,
      })),
      connectors: Array.from({ length: 11 }, (_unused, index) => ({
        fromHole: index + 1,
        toHole: index + 2,
        delayMs: 42,
      })),
    };
    const designed = expectOk(
      await post(`/sites/${site.id}/patterns/${pattern.pattern.id}/design`, 'designer', {
        powderFactorKgM3: 0.55,
        tieIn,
        frequencyHz: 25,
        blastId: blast.id,
      }),
    );
    expect(designed.violations).toEqual([]);
    expect(designed.vibration.compliant).toBe(true);
    expect(designed.totals.holeCount).toBe(12);

    // Approval, then the explosive out of the store.
    expectOk(await post(`/blasts/${blast.id}/complete-design`, 'designer'));
    expectOk(await post(`/blasts/${blast.id}/submit`, 'designer'));
    expectOk(await post(`/blasts/${blast.id}/approve`, 'manager'));
    expectOk(
      await harness.put(`/blasts/${blast.id}/tie-in`, 'designer', { connectors: tieIn.connectors }),
    );
    const issued = expectOk(
      await post(`/blasts/${blast.id}/issues`, 'store', {
        magazineId: magazine.id,
        items: [{ productCode: 'ANFO-80', quantity: 1040 }],
      }),
      201,
    );
    expect(issued.totalKg).toBe(1040);
    expect(
      expectOk(await harness.get(`/magazines/${magazine.id}/stock`, 'viewer')).stock.netExplosiveKg,
    ).toBe(960);

    // Loading, tying in, the clearance and the gate.
    expectOk(await post(`/blasts/${blast.id}/load`, 'shotfirer'));
    expectOk(await post(`/blasts/${blast.id}/tie-in-complete`, 'shotfirer'));
    expectOk(await post(`/blasts/${blast.id}/clearance`, 'shotfirer'), 201);
    for (const item of [
      'plant_withdrawn',
      'people_withdrawn',
      'zone_swept',
      'sentries_posted',
      'roads_stopped',
      'shot_area_clear',
      'warning_signal',
    ]) {
      expectOk(await post(`/blasts/${blast.id}/clearance/${item}`, 'shotfirer', {}));
    }

    const conditions = {
      observation: {
        observedAt: at,
        windSpeedMs: 3,
        windBearingDeg: 90,
        temperatureC: 12,
        temperatureAt10mC: 11.4,
        visibilityM: 9000,
      },
      schedule: { tuesday: [{ from: '13:00', to: '16:00' }] },
    };
    const gate = expectOk(await post(`/blasts/${blast.id}/gate`, 'shotfirer', conditions));
    expect(gate.mayFire).toBe(true);

    const fired = expectOk(await post(`/blasts/${blast.id}/fire`, 'shotfirer', conditions));
    expect(fired.blast.state).toBe('fired');
    expect(fired.blast.shotfirerId).toBe('per_shotfirer');

    // Afterwards: the walk, the survey and what it cost.
    expectOk(
      await post(`/blasts/${blast.id}/inspection`, 'shotfirer', {
        muckpileShape: 'moderate',
        throwM: 14,
        toeGrade: 'slight',
        backbreakM: 1.1,
        oversizeCount: 6,
      }),
      201,
    );
    expectOk(
      await post(`/blasts/${blast.id}/surveys`, 'designer', {
        method: 'laser_scan',
        volumeM3: 1900,
      }),
      201,
    );
    expectOk(
      await post(`/blasts/${blast.id}/dig-records`, 'viewer', { tonnes: 4800, hours: 9 }),
      201,
    );

    const yielded = expectOk(await harness.get(`/blasts/${blast.id}/yield`, 'viewer'));
    expect(yielded.yield.surveyedM3).toBe(1900);
    expect(yielded.yield.digging.tonnesPerHour).toBeCloseTo(533.33, 2);

    const report = expectOk(await harness.get(`/blasts/${blast.id}/report`, 'viewer'));
    expect(report.blast.state).toBe('fired');
    expect(report.metresDrilled).toBe(192);
    expect(report.diggable).toBe(true);

    // The month, and the return that goes to the regulator.
    const period = expectOk(
      await harness.get(
        `/sites/${site.id}/report?from=2026-03-01T00:00:00.000Z&to=2026-03-31T00:00:00.000Z`,
        'manager',
      ),
    );
    expect(period.blastCount).toBe(1);

    const pack = expectOk(
      await harness.get(
        `/sites/${site.id}/regulator-pack?from=2026-03-01T00:00:00.000Z&to=2026-03-31T00:00:00.000Z`,
        'manager',
      ),
    ).pack;
    expect(pack.header.licenceNumber).toBe('EL-4471');
    expect(pack.blasting.count).toBe(1);
    expect(pack.blasting.rows[0].reference).toBe('MDW-2026-014');
    expect(pack.summary.compliant).toBe(true);
    expect(pack.misfires.note).toContain('No misfires');
  });

  it('refuses to fire a shot whose clearance was never finished, and leaves it loaded', async () => {
    const site = expectOk(
      await post('/sites', 'admin', { code: 'RCK', name: 'Rockfield' }),
      201,
    ).site;
    const blast = expectOk(
      await post(`/sites/${site.id}/blasts`, 'designer', { reference: 'RCK-2026-001' }),
      201,
    ).blast;
    expectOk(await post(`/blasts/${blast.id}/complete-design`, 'designer'));
    expectOk(await post(`/blasts/${blast.id}/submit`, 'designer'));
    expectOk(await post(`/blasts/${blast.id}/approve`, 'manager'));
    expectOk(await post(`/blasts/${blast.id}/load`, 'shotfirer'));
    expectOk(await post(`/blasts/${blast.id}/tie-in-complete`, 'shotfirer'));
    expectOk(await post(`/blasts/${blast.id}/clearance`, 'shotfirer'), 201);

    const refused = await post(`/blasts/${blast.id}/fire`, 'shotfirer', {
      observation: {
        observedAt: at,
        windSpeedMs: 3,
        windBearingDeg: 90,
        temperatureC: 12,
        temperatureAt10mC: 11.4,
      },
      schedule: { tuesday: [{ from: '13:00', to: '16:00' }] },
    });
    expect(refused.statusCode).toBe(422);
    expect(
      refused.json().details.violations.some((item) => item.rule === 'clearance.outstanding'),
    ).toBe(true);
    expect(expectOk(await harness.get(`/blasts/${blast.id}`, 'viewer')).blast.state).toBe(
      'tied_in',
    );
  });
});
