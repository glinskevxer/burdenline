import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase } from '../helpers/database.js';
import { buildCommands } from '../../src/cli/commands/index.js';
import { run, EXIT } from '../../src/cli/framework.js';
import { createSite } from '../../src/db/repositories/sites.js';
import {
  createProduct,
  createMagazine,
  createBatch,
  recordMovement,
} from '../../src/db/repositories/explosives.js';
import { fixedClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';

let db;
let commands;
let siteId;
let magazineId;
let productId;
const clock = fixedClock('2026-03-26T09:00:00Z');

function collector() {
  const out = [];
  const err = [];
  return {
    io: { log: (line) => out.push(String(line)), error: (line) => err.push(String(line)) },
    out,
    err,
  };
}

beforeEach(async () => {
  db = await openTestDatabase();
  commands = buildCommands({ db, clock, logger: silentLogger() });
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, { clock }).id;
  productId = createProduct(
    db,
    { code: 'ANFO-80', name: 'Ammonium nitrate fuel oil', kind: 'bulk_anfo', densityKgM3: 800 },
    { clock },
  ).id;
  magazineId = createMagazine(
    db,
    { siteId, name: 'Upper store', netExplosiveLimitKg: 8000 },
    { clock },
  ).id;
});

afterEach(() => closeTestDatabase(db));

function stockUp(quantity = 4000) {
  const batch = createBatch(db, { productId, batchCode: 'L2026-001' }, { clock });
  recordMovement(
    db,
    { magazineId, batchId: batch.id, movement: 'receipt', quantity, massKg: quantity },
    { clock },
  );
  return batch;
}

function consume(batch, days) {
  for (const day of days) {
    recordMovement(
      db,
      {
        magazineId,
        batchId: batch.id,
        movement: 'issue',
        quantity: 900,
        massKg: 900,
        occurredAt: `${day}T13:00:00.000Z`,
        force: true,
      },
      { clock },
    );
  }
}

describe('stock', () => {
  it('prints what each magazine holds', async () => {
    stockUp();
    const { io, out } = collector();
    expect(await run(commands, ['stock', '--site', 'MDW'], io)).toBe(EXIT.ok);
    expect(out[0]).toContain('Upper store: 4000 kg of 8000 kg licensed');
  });

  it('answers not found for a site code nobody uses', async () => {
    const { io, err } = collector();
    expect(await run(commands, ['stock', '--site', 'ZZZ'], io)).toBe(EXIT.notFound);
    expect(err[0]).toContain('no site with code ZZZ');
  });

  it('writes json when asked', async () => {
    stockUp();
    const { io, out } = collector();
    await run(commands, ['stock', '--site', 'MDW', '--format', 'json'], io);
    expect(JSON.parse(out[0])[0].stock.netExplosiveKg).toBe(4000);
  });

  it('needs a site', async () => {
    const { io, err } = collector();
    expect(await run(commands, ['stock'], io)).toBe(EXIT.usage);
    expect(err[0]).toContain('--site');
  });
});

describe('supply-review', () => {
  it('says nothing needs ordering from a full store with no history', async () => {
    stockUp();
    const { io, out } = collector();
    expect(await run(commands, ['supply-review', '--site', 'MDW'], io)).toBe(EXIT.ok);
    expect(out.at(-1)).toContain('0 to order');
  });

  it('says what to order once the history shows it going out', async () => {
    const batch = stockUp(4000);
    consume(batch, ['2026-02-02', '2026-02-09', '2026-02-16', '2026-02-23']);
    const { io, out } = collector();
    const code = await run(commands, ['supply-review', '--site', 'MDW'], io);
    expect(code).toBe(EXIT.refused);
    expect(out.join('\n')).toContain('urgent');
  });

  it('writes json when asked', async () => {
    stockUp();
    const { io, out } = collector();
    await run(commands, ['supply-review', '--site', 'MDW', '--format', 'json'], io);
    expect(JSON.parse(out[0]).items[0].productCode).toBe('ANFO-80');
  });
});

describe('order', () => {
  it('places one for a product', async () => {
    const { io, out } = collector();
    const code = await run(
      commands,
      [
        'order',
        '--site',
        'MDW',
        '--supplier',
        'Kilcorney',
        '--reference',
        'PO-1188',
        '--product',
        'ANFO-80',
        '--quantity',
        '4000',
      ],
      io,
    );
    expect(code).toBe(EXIT.ok);
    expect(out[0]).toContain('PO-1188 placed with Kilcorney');
  });

  it('refuses a quantity of nothing', async () => {
    const { io, err } = collector();
    const code = await run(
      commands,
      [
        'order',
        '--site',
        'MDW',
        '--supplier',
        'Kilcorney',
        '--reference',
        'PO-2',
        '--product',
        'ANFO-80',
        '--quantity',
        '0',
      ],
      io,
    );
    expect(code).toBe(EXIT.usage);
    expect(err[0]).toContain('more than nothing');
  });

  it('names every option it is missing', async () => {
    const { io, err } = collector();
    expect(await run(commands, ['order', '--site', 'MDW'], io)).toBe(EXIT.usage);
    expect(err[0]).toContain('--supplier');
  });

  it('refuses a product nobody stocks', async () => {
    const { io } = collector();
    const code = await run(
      commands,
      [
        'order',
        '--site',
        'MDW',
        '--supplier',
        'K',
        '--reference',
        'PO-3',
        '--product',
        'TNT-1',
        '--quantity',
        '10',
      ],
      io,
    );
    expect(code).toBe(EXIT.refused);
  });
});
