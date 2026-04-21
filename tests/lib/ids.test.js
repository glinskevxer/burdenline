import { describe, it, expect } from 'vitest';
import {
  newId,
  isId,
  prefixOf,
  assertId,
  shotReference,
  parseShotReference,
  idAlphabet,
} from '../../src/lib/ids.js';
import { AppError } from '../../src/lib/errors.js';

describe('newId', () => {
  it('prefixes the id with the kind of record', () => {
    expect(newId('hole').startsWith('hole_')).toBe(true);
  });

  it('produces ids of a fixed length', () => {
    const id = newId('pat');
    expect(id.slice(id.indexOf('_') + 1)).toHaveLength(22);
  });

  it('uses an alphabet without the letters that get misread', () => {
    const body = newId('blast').split('_')[1];
    for (const character of body) {
      expect(idAlphabet).toContain(character);
    }
    expect(idAlphabet).not.toContain('i');
    expect(idAlphabet).not.toContain('l');
    expect(idAlphabet).not.toContain('o');
    expect(idAlphabet).not.toContain('u');
  });

  it('sorts by creation order', () => {
    let clock = 1_700_000_000_000;
    const first = newId('rec', { now: () => clock });
    clock += 5;
    const second = newId('rec', { now: () => clock });
    expect(first < second).toBe(true);
  });

  it('keeps two ids made in the same millisecond apart', () => {
    const now = () => 1_700_000_000_000;
    const ids = new Set();
    for (let i = 0; i < 50; i += 1) {
      ids.add(newId('mon', { now, random: () => 0.5 }));
    }
    expect(ids.size).toBe(50);
  });

  it('refuses a prefix nothing uses', () => {
    expect(() => newId('widget')).toThrow(AppError);
  });
});

describe('isId', () => {
  it('accepts an id it just made', () => {
    expect(isId(newId('site'))).toBe(true);
  });

  it('checks the prefix when one is asked for', () => {
    const id = newId('site');
    expect(isId(id, 'site')).toBe(true);
    expect(isId(id, 'bench')).toBe(false);
  });

  it('rejects the shapes that turn up in bad data', () => {
    expect(isId('')).toBe(false);
    expect(isId('_abc')).toBe(false);
    expect(isId('hole_short')).toBe(false);
    expect(isId('unknown_0123456789abcdefghjkmn')).toBe(false);
    expect(isId(42)).toBe(false);
    expect(isId(null)).toBe(false);
  });

  it('rejects a body with a letter outside the alphabet', () => {
    const id = newId('hole');
    expect(isId(id.replace(/.$/, 'i'))).toBe(false);
  });
});

describe('prefixOf and assertId', () => {
  it('reads the prefix back', () => {
    expect(prefixOf(newId('cert'))).toBe('cert');
  });

  it('throws on anything that is not an id', () => {
    expect(() => prefixOf('nonsense')).toThrow(AppError);
  });

  it('returns the id when it matches', () => {
    const id = newId('mag');
    expect(assertId(id, 'mag')).toBe(id);
  });

  it('names the prefix it wanted', () => {
    const id = newId('mag');
    expect(() => assertId(id, 'hole')).toThrow(/expected a hole identifier/);
  });
});

describe('shot references', () => {
  it('pads the sequence to three digits', () => {
    expect(shotReference('MDW', 2025, 14)).toBe('MDW-2025-014');
  });

  it('reads one back', () => {
    expect(parseShotReference('CRG-2026-007')).toEqual({
      siteCode: 'CRG',
      year: 2026,
      sequence: 7,
    });
  });

  it('refuses a lowercase or overlong site code', () => {
    expect(() => shotReference('mdw', 2025, 1)).toThrow(AppError);
    expect(() => shotReference('MIDWAYQUARRY', 2025, 1)).toThrow(AppError);
  });

  it('refuses a sequence outside one year of shooting', () => {
    expect(() => shotReference('MDW', 2025, 0)).toThrow(AppError);
    expect(() => shotReference('MDW', 2025, 1000)).toThrow(AppError);
  });

  it('refuses a reference that is not one', () => {
    expect(() => parseShotReference('MDW-25-1')).toThrow(AppError);
  });
});

describe('the corners of the identifier format', () => {
  it('rolls the per millisecond counter over rather than growing the id', () => {
    const now = () => 1_700_000_000_000;
    const ids = new Set();
    for (let i = 0; i < 1100; i += 1) {
      ids.add(newId('hole', { now, random: () => 0.25 }));
    }
    const lengths = new Set([...ids].map((id) => id.length));
    expect(lengths.size).toBe(1);
  });

  it('keeps the alphabet inside its bounds whatever the random source gives', () => {
    const id = newId('hole', { random: () => 0.999999 });
    expect(isId(id)).toBe(true);
    const lowest = newId('hole', { random: () => 0 });
    expect(isId(lowest)).toBe(true);
  });

  it('encodes a time of zero without overflowing the field', () => {
    const id = newId('site', { now: () => 0, random: () => 0.5 });
    expect(id.split('_')[1]).toHaveLength(22);
  });
});
