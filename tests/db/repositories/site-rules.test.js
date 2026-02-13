import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase } from '../../helpers/database.js';
import { createSite } from '../../../src/db/repositories/sites.js';
import {
  RULE_SETS,
  ruleSetNames,
  defaultsFor,
  rulesFor,
  allRulesFor,
  setRules,
  history,
  resetRules,
} from '../../../src/db/repositories/site-rules.js';
import { DEFAULT_CHARGE_RULES } from '../../../src/domain/charging/rules.js';
import { fixedClock } from '../../../src/lib/clock.js';
import { NotFoundError, ValidationError } from '../../../src/lib/errors.js';

let db;
let siteId;
const clock = fixedClock('2026-02-06T09:00:00Z');
const context = { clock };

beforeEach(async () => {
  db = await openTestDatabase();
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, context).id;
});

afterEach(() => closeTestDatabase(db));

describe('the rule sets', () => {
  it('carries one per set of defaults in the domain', () => {
    expect(ruleSetNames()).toEqual([
      'batch',
      'charge',
      'exclusion',
      'notice',
      'reconcile',
      'response',
      'timing',
      'weather',
    ]);
  });

  it('hands back the domain defaults untouched', () => {
    expect(defaultsFor('charge')).toBe(DEFAULT_CHARGE_RULES);
    expect(Object.isFrozen(RULE_SETS)).toBe(true);
  });

  it('refuses a set nobody has', () => {
    expect(() => defaultsFor('catering')).toThrow(ValidationError);
  });
});

describe('rulesFor', () => {
  it('gives a site that has set nothing the defaults, and says so', () => {
    const rules = rulesFor(db, siteId, 'charge');
    expect(rules.source).toBe('default');
    expect(rules.values.minimumStemmingDiameters).toBe(20);
  });

  it('lays an override over the defaults', () => {
    setRules(db, { siteId, ruleSet: 'charge', values: { minimumStemmingDiameters: 25 } }, context);
    const rules = rulesFor(db, siteId, 'charge');
    expect(rules.source).toBe('site');
    expect(rules.values.minimumStemmingDiameters).toBe(25);
    expect(rules.values.minimumChargeLengthM).toBe(DEFAULT_CHARGE_RULES.minimumChargeLengthM);
    expect(rules.overrides).toEqual({ minimumStemmingDiameters: 25 });
  });

  it('reads every set at once', () => {
    setRules(db, { siteId, ruleSet: 'weather', values: { maximumWindSpeedMs: 8 } }, context);
    const all = allRulesFor(db, siteId);
    expect(all.weather.values.maximumWindSpeedMs).toBe(8);
    expect(all.timing.source).toBe('default');
  });
});

describe('setRules', () => {
  it('records who set them and why', () => {
    const rules = setRules(
      db,
      {
        siteId,
        ruleSet: 'charge',
        values: { minimumStemmingDiameters: 25 },
        setBy: null,
        note: 'agreed with the regulator after the March exceedance',
      },
      context,
    );
    expect(rules.note).toContain('regulator');
    expect(rules.setAt).toBe(clock.now());
  });

  it('supersedes the old set rather than editing it', () => {
    setRules(db, { siteId, ruleSet: 'charge', values: { minimumStemmingDiameters: 25 } }, context);
    setRules(db, { siteId, ruleSet: 'charge', values: { minimumStemmingDiameters: 30 } }, context);
    expect(rulesFor(db, siteId, 'charge').values.minimumStemmingDiameters).toBe(30);
    const past = history(db, siteId, 'charge');
    expect(past).toHaveLength(2);
    expect(past.filter((row) => row.supersededAt !== null)).toHaveLength(1);
  });

  it('refuses a rule the set does not have', () => {
    expect(() =>
      setRules(db, { siteId, ruleSet: 'charge', values: { minimumBeerFridges: 2 } }, context),
    ).toThrow(/no minimumBeerFridges/);
  });

  it('refuses a value of the wrong kind', () => {
    expect(() =>
      setRules(
        db,
        { siteId, ruleSet: 'charge', values: { minimumStemmingDiameters: 'lots' } },
        context,
      ),
    ).toThrow(ValidationError);
  });

  it('refuses a site that is not there', () => {
    expect(() =>
      setRules(db, { siteId: 'site_missing', ruleSet: 'charge', values: {} }, context),
    ).toThrow(NotFoundError);
  });

  it('takes a boolean rule', () => {
    setRules(db, { siteId, ruleSet: 'weather', values: { inversionBlocks: false } }, context);
    expect(rulesFor(db, siteId, 'weather').values.inversionBlocks).toBe(false);
  });
});

describe('resetRules', () => {
  it('puts a set back to the defaults', () => {
    setRules(db, { siteId, ruleSet: 'charge', values: { minimumStemmingDiameters: 25 } }, context);
    resetRules(db, { siteId, ruleSet: 'charge' }, context);
    expect(rulesFor(db, siteId, 'charge').values.minimumStemmingDiameters).toBe(20);
  });

  it('leaves the history showing what was in force before', () => {
    setRules(db, { siteId, ruleSet: 'charge', values: { minimumStemmingDiameters: 25 } }, context);
    resetRules(db, { siteId, ruleSet: 'charge' }, context);
    expect(history(db, siteId, 'charge')).toHaveLength(2);
  });

  it('refuses to reset a set nobody has overridden', () => {
    expect(() => resetRules(db, { siteId, ruleSet: 'timing' }, context)).toThrow(NotFoundError);
  });
});
