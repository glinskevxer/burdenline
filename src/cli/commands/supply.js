/**
 * The store commands.
 *
 * `supply-review` is the one that gets run: it prints what to order, worked out
 * from what has actually been used, and it exits non zero when something is
 * urgent so it can be put in a cron job that emails on failure.
 */

import * as orders from '../../db/repositories/orders.js';
import * as explosives from '../../db/repositories/explosives.js';
import * as sites from '../../db/repositories/sites.js';
import { EXIT, UsageError, required, number } from '../framework.js';

function siteFor(db, code, io) {
  const site = sites.findSiteByCode(db, code);
  if (!site) {
    io.error(`there is no site with code ${code}`);
    return null;
  }
  return site;
}

export function supplyCommands({ db, clock }) {
  const context = { clock };

  return {
    'supply-review': {
      summary: 'say what the store needs ordering, from what it has been using',
      usage: '--site MDW [--from 2026-01-01] [--format json]',
      options: {
        site: 'the site code',
        from: 'only count use since this instant',
        format: 'text or json',
      },
      async run({ options, io }) {
        required(options, ['site']);
        const site = siteFor(db, options.site, io);
        if (!site) {
          return EXIT.notFound;
        }
        const review = orders.reviewSupply(db, site.id, { from: options.from });
        if (options.format === 'json') {
          io.log(JSON.stringify(review, null, 2));
        } else {
          for (const item of review.items) {
            const cover = item.daysOfCover === null ? 'no history' : `${item.daysOfCover} days`;
            io.log(
              `${item.productCode.padEnd(10)} held ${String(item.held).padStart(8)}  on order ${String(item.onOrder).padStart(8)}  cover ${cover}  ${item.action}`,
            );
            if (item.note) {
              io.log(`  ${item.note}`);
            }
          }
          io.log(`${review.toOrder.length} to order, ${review.urgent} urgent`);
        }
        return review.urgent > 0 ? EXIT.refused : EXIT.ok;
      },
    },

    stock: {
      summary: 'print what every magazine on a site is holding',
      usage: '--site MDW',
      options: { site: 'the site code', format: 'text or json' },
      async run({ options, io }) {
        required(options, ['site']);
        const site = siteFor(db, options.site, io);
        if (!site) {
          return EXIT.notFound;
        }
        const magazines = explosives.listMagazines(db, site.id).map((magazine) => ({
          magazine,
          stock: explosives.stockFor(db, magazine.id),
        }));
        if (options.format === 'json') {
          io.log(JSON.stringify(magazines, null, 2));
          return EXIT.ok;
        }
        for (const { magazine, stock } of magazines) {
          io.log(
            `${magazine.name}: ${stock.netExplosiveKg} kg of ${magazine.netExplosiveLimitKg} kg licensed, ${stock.batches.length} batches`,
          );
          for (const violation of stock.violations) {
            io.error(`  ${violation.rule}: ${violation.message}`);
          }
        }
        return magazines.every(({ stock }) => stock.valid) ? EXIT.ok : EXIT.refused;
      },
    },

    order: {
      summary: 'place an order for one product',
      usage:
        '--site MDW --supplier Kilcorney --reference PO-1188 --product ANFO-80 --quantity 4000',
      options: {
        site: 'the site code',
        supplier: 'who it is being ordered from',
        reference: 'the order reference',
        product: 'the product code',
        quantity: 'how much of it',
      },
      async run({ options, io }) {
        required(options, ['site', 'supplier', 'reference', 'product', 'quantity']);
        const quantity = number(options.quantity, 'quantity');
        if (!(quantity > 0)) {
          throw new UsageError('--quantity has to be more than nothing');
        }
        const site = siteFor(db, options.site, io);
        if (!site) {
          return EXIT.notFound;
        }
        const placed = orders.placeOrder(
          db,
          {
            siteId: site.id,
            supplier: options.supplier,
            reference: options.reference,
            expectedOn: options.expected ?? null,
            lines: [{ productCode: options.product, quantity }],
          },
          context,
        );
        io.log(
          `${placed.reference} placed with ${placed.supplier} for ${quantity} of ${options.product}`,
        );
        return EXIT.ok;
      },
    },
  };
}
