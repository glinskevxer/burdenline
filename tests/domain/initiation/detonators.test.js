import { describe, it, expect } from 'vitest';
import {
  parseDetonator,
  scatterWindowMs,
  firingWindow,
  windowsOverlap,
  standardCatalogue,
  findDetonator,
  programmed,
  DETONATOR_FAMILIES,
  DETONATOR_ROLES,
} from '../../../src/domain/initiation/detonators.js';
import { ValidationError } from '../../../src/lib/errors.js';

const surface = {
  code: 'SC-25',
  family: 'pyrotechnic',
  role: 'surface',
  nominalDelayMs: 25,
  scatterPercent: 4,
};

const electronic = {
  code: 'EL-PROG',
  family: 'electronic',
  role: 'in_hole',
  nominalDelayMs: 0,
  scatterMs: 1,
  programmable: true,
};

describe('parseDetonator', () => {
  it('takes a shock tube surface connector', () => {
    const detonator = parseDetonator(surface);
    expect(detonator.nominalDelayMs).toBe(25);
    expect(Object.isFrozen(detonator)).toBe(true);
  });

  it('refuses a detonator that does not say how much it scatters', () => {
    expect(() => parseDetonator({ ...surface, scatterPercent: null })).toThrow(
      /declare its scatter/,
    );
  });

  it('refuses an electronic detonator quoted as a percentage', () => {
    expect(() => parseDetonator({ ...electronic, scatterPercent: 2, scatterMs: null })).toThrow(
      /not a percentage/,
    );
  });

  it('refuses a delay longer than any shot runs', () => {
    expect(() => parseDetonator({ ...surface, nominalDelayMs: 40000 })).toThrow(ValidationError);
  });

  it('refuses a family nobody sells', () => {
    expect(() => parseDetonator({ ...surface, family: 'electric' })).toThrow(ValidationError);
  });
});

describe('scatter', () => {
  it('reads a percentage against the nominal delay', () => {
    expect(
      scatterWindowMs(parseDetonator({ ...surface, nominalDelayMs: 500, scatterPercent: 3 })),
    ).toBe(15);
  });

  it('reads a fixed window straight off', () => {
    expect(scatterWindowMs(parseDetonator(electronic))).toBe(1);
  });

  it('grows with the delay, which is why long delays scatter worst', () => {
    const detonator = parseDetonator({ ...surface, scatterPercent: 3 });
    expect(scatterWindowMs(detonator, 1000)).toBeGreaterThan(scatterWindowMs(detonator, 100));
  });

  it('brackets the nominal time', () => {
    const window = firingWindow(
      parseDetonator({ ...surface, nominalDelayMs: 500, scatterPercent: 3 }),
    );
    expect(window).toEqual({ earliestMs: 485, latestMs: 515 });
  });
});

describe('windowsOverlap', () => {
  it('spots two pyrotechnic delays that can fire together', () => {
    const a = { earliestMs: 485, latestMs: 515 };
    const b = { earliestMs: 510, latestMs: 540 };
    expect(windowsOverlap(a, b)).toBe(true);
  });

  it('keeps two well separated delays apart', () => {
    expect(windowsOverlap({ earliestMs: 0, latestMs: 10 }, { earliestMs: 20, latestMs: 30 })).toBe(
      false,
    );
  });

  it('counts touching windows as overlapping, which is the safe reading', () => {
    expect(windowsOverlap({ earliestMs: 0, latestMs: 20 }, { earliestMs: 20, latestMs: 40 })).toBe(
      true,
    );
  });
});

describe('the standard catalogue', () => {
  const catalogue = standardCatalogue();

  it('carries the surface connectors a crew ties a shot with', () => {
    const codes = catalogue.filter((d) => d.role === 'surface').map((d) => d.code);
    expect(codes).toEqual(['SC-17', 'SC-25', 'SC-42', 'SC-65', 'SC-100', 'SC-200']);
  });

  it('colours them the way the boxes are', () => {
    expect(findDetonator(catalogue, 'SC-25').colour).toBe('red');
    expect(findDetonator(catalogue, 'SC-65').colour).toBe('blue');
  });

  it('carries the in hole delays around half a second', () => {
    const inHole = catalogue.filter((d) => d.role === 'in_hole' && d.family === 'pyrotechnic');
    expect(inHole.map((d) => d.nominalDelayMs)).toEqual([400, 425, 450, 475, 500]);
  });

  it('scatters the in hole delays less than the surface ones by percentage', () => {
    expect(findDetonator(catalogue, 'IH-500').scatterPercent).toBe(3);
    expect(findDetonator(catalogue, 'SC-25').scatterPercent).toBe(4);
  });

  it('carries one programmable electronic detonator', () => {
    expect(findDetonator(catalogue, 'EL-PROG').programmable).toBe(true);
  });

  it('refuses to find something that is not there', () => {
    expect(() => findDetonator(catalogue, 'SC-9')).toThrow(/no detonator SC-9/);
  });
});

describe('programmed', () => {
  const catalogue = standardCatalogue();

  it('sets the time on an electronic detonator', () => {
    const set = programmed(findDetonator(catalogue, 'EL-PROG'), 1375);
    expect(set.nominalDelayMs).toBe(1375);
    expect(scatterWindowMs(set)).toBe(1);
  });

  it('refuses to reprogram a pyrotechnic element', () => {
    expect(() => programmed(findDetonator(catalogue, 'IH-500'), 600)).toThrow(/not programmable/);
  });

  it('refuses a time that is not a whole millisecond in range', () => {
    const detonator = findDetonator(catalogue, 'EL-PROG');
    expect(() => programmed(detonator, 12.5)).toThrow(ValidationError);
    expect(() => programmed(detonator, -1)).toThrow(ValidationError);
    expect(() => programmed(detonator, 25000)).toThrow(ValidationError);
  });
});

describe('the vocabularies', () => {
  it('names both families and all three roles', () => {
    expect(DETONATOR_FAMILIES).toEqual(['pyrotechnic', 'electronic']);
    expect(DETONATOR_ROLES).toEqual(['surface', 'in_hole', 'trunkline']);
  });
});
