/**
 * Delay elements.
 *
 * Two families are in use and they behave differently enough that mixing them in
 * one shot needs care. A pyrotechnic delay burns a chemical element and its
 * actual firing time scatters by a percentage of the nominal, so a 500 ms
 * in-hole delay can fire anywhere in a window tens of milliseconds wide.
 * An electronic detonator is programmed and holds to a millisecond or two.
 * The scatter matters because the maximum instantaneous charge is worked out
 * from which holes fire together, and pyrotechnic scatter can put two holes in
 * the same window that the design had eight milliseconds apart.
 */

import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';

export const DETONATOR_FAMILIES = ['pyrotechnic', 'electronic'];
export const DETONATOR_ROLES = ['surface', 'in_hole', 'trunkline'];

export const detonatorSchema = z.object({
  code: z.string().min(2).max(16),
  family: z.enum(['pyrotechnic', 'electronic']),
  role: z.enum(['surface', 'in_hole', 'trunkline']),
  nominalDelayMs: z.number().int().min(0).max(20000),
  scatterPercent: z.number().min(0).max(20).nullable().default(null),
  scatterMs: z.number().min(0).max(200).nullable().default(null),
  colour: z.string().max(20).nullable().default(null),
  programmable: z.boolean().default(false),
});

export function parseDetonator(input) {
  const parsed = detonatorSchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the detonator is not usable');
  }
  const detonator = parsed.data;
  if (detonator.scatterPercent === null && detonator.scatterMs === null) {
    throw new ValidationError('a detonator has to declare its scatter', [
      { path: 'scatterPercent', message: 'give a percentage or a fixed window', kind: 'missing' },
    ]);
  }
  if (detonator.family === 'electronic' && detonator.scatterPercent !== null) {
    throw new ValidationError(
      'an electronic detonator scatters by a fixed window, not a percentage',
      [
        {
          path: 'scatterPercent',
          message: 'use scatterMs for an electronic detonator',
          kind: 'conflict',
        },
      ],
    );
  }
  return Object.freeze(detonator);
}

/** Half width of the window a detonator can actually fire in. */
export function scatterWindowMs(detonator, delayMs = detonator.nominalDelayMs) {
  if (detonator.scatterMs !== null) {
    return roundTo(detonator.scatterMs, 3);
  }
  return roundTo((delayMs * detonator.scatterPercent) / 100, 3);
}

export function firingWindow(detonator, delayMs = detonator.nominalDelayMs) {
  const half = scatterWindowMs(detonator, delayMs);
  return { earliestMs: roundTo(delayMs - half, 3), latestMs: roundTo(delayMs + half, 3) };
}

/** Do two elements at these times share any part of their firing windows? */
export function windowsOverlap(a, b) {
  return a.earliestMs <= b.latestMs && b.earliestMs <= a.latestMs;
}

/** The standard shock tube range, which is what most of these quarries shoot. */
export function standardCatalogue() {
  const surface = [17, 25, 42, 65, 100, 200].map((delay) =>
    parseDetonator({
      code: `SC-${delay}`,
      family: 'pyrotechnic',
      role: 'surface',
      nominalDelayMs: delay,
      scatterPercent: 4,
      colour: surfaceColour(delay),
    }),
  );
  const inHole = [400, 425, 450, 475, 500].map((delay) =>
    parseDetonator({
      code: `IH-${delay}`,
      family: 'pyrotechnic',
      role: 'in_hole',
      nominalDelayMs: delay,
      scatterPercent: 3,
      colour: 'red',
    }),
  );
  const electronic = parseDetonator({
    code: 'EL-PROG',
    family: 'electronic',
    role: 'in_hole',
    nominalDelayMs: 0,
    scatterMs: 1,
    programmable: true,
  });
  return [...surface, ...inHole, electronic];
}

export function findDetonator(catalogue, code) {
  const found = catalogue.find((detonator) => detonator.code === code);
  if (!found) {
    throw new ValidationError(`there is no detonator ${code} in the catalogue`, [
      { path: 'code', message: 'unknown detonator', kind: 'missing' },
    ]);
  }
  return found;
}

/** Program an electronic detonator to a time. Anything else keeps its element. */
export function programmed(detonator, delayMs) {
  if (!detonator.programmable) {
    throw new ValidationError(`${detonator.code} is not programmable`, [
      {
        path: 'delayMs',
        message: 'this detonator fires on its fixed element',
        kind: 'unsupported',
      },
    ]);
  }
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 20000) {
    throw new ValidationError('a programmed delay is a whole number of milliseconds up to 20000', [
      { path: 'delayMs', message: 'out of range', kind: 'range' },
    ]);
  }
  return Object.freeze({ ...detonator, nominalDelayMs: delayMs });
}

function surfaceColour(delay) {
  return (
    { 17: 'yellow', 25: 'red', 42: 'white', 65: 'blue', 100: 'green', 200: 'black' }[delay] ?? null
  );
}
