import { describe, it, expect } from 'vitest';
import {
  movementTotals,
  unaccounted,
  reconcileProduct,
  reconcileShot,
  discrepancyReport,
  DEFAULT_RECONCILE_RULES,
} from '../../../src/domain/magazine/reconcile.js';
import { ValidationError } from '../../../src/lib/errors.js';

function line(movement, quantity, overrides = {}) {
  return {
    id: `led_${movement}_${quantity}`,
    blastId: 'blast_1',
    productCode: 'ANFO-80',
    unit: 'kg',
    movement,
    quantity,
    massKg: quantity,
    ...overrides,
  };
}

describe('movementTotals', () => {
  it('sorts the lines into the four buckets', () => {
    const totals = movementTotals([
      line('issue', -1000),
      line('consumption', -960),
      line('return', 40),
      line('disposal', -0),
    ]);
    expect(totals).toEqual({ issued: 1000, consumed: 960, returned: 40, disposed: 0 });
  });

  it('ignores movements that are not part of the shot', () => {
    expect(movementTotals([line('receipt', 2000), line('issue', -100)]).issued).toBe(100);
  });

  it('reads the magnitude whichever sign the line carries', () => {
    expect(movementTotals([line('issue', 500)]).issued).toBe(500);
  });
});

describe('unaccounted', () => {
  it('is nothing when the shot balances', () => {
    expect(unaccounted({ issued: 1000, consumed: 960, returned: 40, disposed: 0 })).toBe(0);
  });

  it('is positive when explosive is missing', () => {
    expect(unaccounted({ issued: 1000, consumed: 900, returned: 40, disposed: 0 })).toBe(60);
  });

  it('is negative when more came back than went out', () => {
    expect(unaccounted({ issued: 1000, consumed: 900, returned: 150, disposed: 0 })).toBe(-50);
  });
});

describe('reconcileProduct', () => {
  const balanced = {
    productCode: 'ANFO-80',
    unit: 'kg',
    designedQuantity: 960,
    lines: [line('issue', -1000), line('consumption', -960), line('return', 40)],
  };

  it('passes a shot that balances', () => {
    expect(reconcileProduct(balanced).valid).toBe(true);
  });

  it('lets a couple of kilograms go on a bulk truck', () => {
    const noisy = {
      ...balanced,
      lines: [line('issue', -1000), line('consumption', -957), line('return', 40)],
    };
    expect(reconcileProduct(noisy).valid).toBe(true);
    expect(reconcileProduct(noisy).unaccounted).toBe(3);
  });

  it('flags a real shortfall', () => {
    const short = {
      ...balanced,
      lines: [line('issue', -1000), line('consumption', -900), line('return', 40)],
    };
    const result = reconcileProduct(short);
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe('reconcile.unaccounted');
  });

  it('flags more coming back than went out', () => {
    const over = {
      ...balanced,
      lines: [line('issue', -1000), line('consumption', -900), line('return', 200)],
    };
    expect(reconcileProduct(over).violations[0].rule).toBe('reconcile.over_returned');
  });

  it('gives counted items no tolerance at all', () => {
    const detonators = {
      productCode: 'IH-500',
      unit: 'each',
      designedQuantity: 60,
      lines: [
        line('issue', -62, { unit: 'each', productCode: 'IH-500' }),
        line('consumption', -60, { unit: 'each', productCode: 'IH-500' }),
        line('return', 1, { unit: 'each', productCode: 'IH-500' }),
      ],
    };
    const result = reconcileProduct(detonators);
    expect(result.valid).toBe(false);
    expect(result.unaccounted).toBe(1);
  });

  it('flags a shot loaded well off its design', () => {
    const heavy = {
      ...balanced,
      designedQuantity: 700,
      lines: [line('issue', -1000), line('consumption', -960), line('return', 40)],
    };
    const result = reconcileProduct(heavy);
    expect(result.violations.map((v) => v.rule)).toContain('reconcile.off_design');
  });

  it('says nothing about the design when there was none', () => {
    const result = reconcileProduct({ ...balanced, designedQuantity: null });
    expect(result.valid).toBe(true);
    expect(result.designedQuantity).toBe(null);
  });

  it('follows a tighter tolerance from the site', () => {
    const noisy = {
      ...balanced,
      lines: [line('issue', -1000), line('consumption', -957), line('return', 40)],
    };
    const result = reconcileProduct(noisy, {
      rules: { bulkToleranceKg: 1, bulkTolerancePercent: 0.1 },
    });
    expect(result.valid).toBe(false);
  });

  it('publishes the tolerance it applied', () => {
    expect(reconcileProduct(balanced).toleranceApplied).toBe(15);
    expect(DEFAULT_RECONCILE_RULES.bulkTolerancePercent).toBe(1.5);
  });
});

describe('reconcileShot', () => {
  const lines = [
    line('issue', -1000),
    line('consumption', -960),
    line('return', 40),
    line('issue', -62, { unit: 'each', productCode: 'IH-500' }),
    line('consumption', -60, { unit: 'each', productCode: 'IH-500' }),
    line('return', 2, { unit: 'each', productCode: 'IH-500' }),
  ];

  it('reconciles each product separately', () => {
    const result = reconcileShot({ blastId: 'blast_1', lines });
    expect(result.products.map((product) => product.productCode)).toEqual(['ANFO-80', 'IH-500']);
    expect(result.balanced).toBe(true);
  });

  it('adds up only the products measured in kilograms', () => {
    const result = reconcileShot({ blastId: 'blast_1', lines });
    expect(result.totalIssued).toBe(1000);
    expect(result.totalConsumed).toBe(960);
  });

  it('catches one product short even when the shot looks fine overall', () => {
    const uneven = [
      line('issue', -1000),
      line('consumption', -900),
      line('return', 40),
      line('issue', -500, { productCode: 'EM-115' }),
      line('consumption', -560, { productCode: 'EM-115' }),
    ];
    const result = reconcileShot({ blastId: 'blast_1', lines: uneven });
    expect(result.balanced).toBe(false);
    expect(result.violations).toHaveLength(2);
  });

  it('includes a product that was designed but never issued', () => {
    const result = reconcileShot({
      blastId: 'blast_1',
      designed: [{ productCode: 'EM-115', quantity: 300, unit: 'kg' }],
      lines,
    });
    const emulsion = result.products.find((product) => product.productCode === 'EM-115');
    expect(emulsion.issued).toBe(0);
    expect(emulsion.violations.map((v) => v.rule)).toContain('reconcile.off_design');
  });

  it('calls a quantity discrepancy reportable and a design drift not', () => {
    const drifted = reconcileShot({
      blastId: 'blast_1',
      designed: [{ productCode: 'ANFO-80', quantity: 700, unit: 'kg' }],
      lines: lines.slice(0, 3),
    });
    expect(drifted.balanced).toBe(false);
    expect(drifted.reportable).toBe(false);
  });

  it('refuses a reconciliation with no shot', () => {
    expect(() => reconcileShot({ lines })).toThrow(ValidationError);
  });
});

describe('discrepancyReport', () => {
  it('writes nothing when there is nothing to report', () => {
    const clean = reconcileShot({
      blastId: 'blast_1',
      lines: [line('issue', -100), line('consumption', -100)],
    });
    expect(discrepancyReport(clean, { reportedBy: 'M Cronin', occurredOn: '2025-06-24' })).toBe(
      null,
    );
  });

  it('names the products and quantities that did not reconcile', () => {
    const short = reconcileShot({
      blastId: 'blast_1',
      lines: [line('issue', -1000), line('consumption', -900)],
    });
    const report = discrepancyReport(short, { reportedBy: 'M Cronin', occurredOn: '2025-06-24' });
    expect(report.totalItems).toBe(1);
    expect(report.items[0].productCode).toBe('ANFO-80');
    expect(report.reportedBy).toBe('M Cronin');
    expect(report.summary).toContain('1 product line');
  });
});
