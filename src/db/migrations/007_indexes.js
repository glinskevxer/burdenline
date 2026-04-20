/**
 * Indexes the query plans asked for.
 *
 * Every one of these was added because a query in the performance tests was
 * doing a table scan, and the plan is recorded in the comment beside it so the
 * next person can tell whether it is still needed. An index nobody can explain
 * is an index nobody dares delete.
 *
 * The ledger one is the important one: the stock check groups by batch inside a
 * transaction on every movement, and on a store with a few thousand lines that
 * scan was showing up as a visible pause when the crew pressed issue.
 */

export const migration = {
  id: '007',
  name: 'indexes for the hot reads',
  up(db) {
    db.exec(`
      -- The stock check: WHERE magazine_id = ? AND movement <> 'consumption' GROUP BY batch_id
      CREATE INDEX ledger_stock ON magazine_ledger (magazine_id, movement, batch_id);

      -- Reading a shot's decks in hole order, which the load sheet does per hole.
      CREATE INDEX deck_by_hole ON charge_deck (hole_id, deck_number);

      -- The compliance sweep: records for a site inside a period, by receptor.
      CREATE INDEX record_by_receptor ON monitor_record (site_id, receptor_id, triggered_at);

      -- The period report walks fired shots by date rather than by state.
      CREATE INDEX blast_by_site_fired ON blast (site_id, fired_at);

      -- The notice sweep looks for shots planned inside a window.
      CREATE INDEX blast_by_planned ON blast (planned_for) WHERE planned_for IS NOT NULL;

      -- The ordering screen sums outstanding lines per product.
      CREATE INDEX order_line_by_product ON supply_order_line (product_id, order_id);

      -- Reading the rules in force for a site, which every design does.
      CREATE INDEX rules_current ON site_rules (site_id, rule_set) WHERE superseded_at IS NULL;

      ANALYZE;
    `);
  },
};

export default migration;
