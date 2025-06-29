import { describe, it, expect } from 'vitest';
import {
  parsePerson,
  parseCertificate,
  isCurrent,
  daysToExpiry,
  heldBy,
  endorsementsFor,
  mayFire,
  endorsementsNeeded,
  expiringSoon,
  ROLES,
  ENDORSEMENTS,
} from '../../../src/domain/people/competency.js';
import { ValidationError } from '../../../src/lib/errors.js';

const onDate = '2025-06-26';

const shotfirer = parsePerson({
  id: 'per_1',
  name: 'M Cronin',
  roles: ['shotfirer', 'charge_hand'],
  employer: 'Midway Aggregates',
});

const driller = parsePerson({ id: 'per_2', name: 'S Nolan', roles: ['driller'] });

function certificate(overrides = {}) {
  return parseCertificate({
    id: 'cert_1',
    personId: 'per_1',
    kind: 'shotfirer',
    reference: 'SF-2201',
    issuedOn: '2023-01-15',
    expiresOn: '2028-01-15',
    endorsements: ['bulk_explosive', 'shock_tube_initiation'],
    ...overrides,
  });
}

describe('parsing', () => {
  it('takes a person with roles', () => {
    expect(shotfirer.roles).toContain('shotfirer');
    expect(Object.isFrozen(shotfirer)).toBe(true);
  });

  it('refuses a person with no role', () => {
    expect(() => parsePerson({ id: 'p', name: 'Nobody', roles: [] })).toThrow(ValidationError);
  });

  it('refuses a role nobody holds', () => {
    expect(() => parsePerson({ id: 'p', name: 'Someone', roles: ['pilot'] })).toThrow(
      ValidationError,
    );
  });

  it('refuses a certificate that expires before it was issued', () => {
    expect(() => certificate({ expiresOn: '2022-01-01' })).toThrow(/cannot expire before/);
  });

  it('refuses an endorsement that is not one', () => {
    expect(() => certificate({ endorsements: ['welding'] })).toThrow(/is not an endorsement/);
  });

  it('lists the roles and endorsements it knows', () => {
    expect(ROLES).toContain('sentry');
    expect(ENDORSEMENTS).toContain('design_approval');
  });
});

describe('currency', () => {
  it('reads a certificate inside its dates as current', () => {
    expect(isCurrent(certificate(), onDate)).toBe(true);
  });

  it('reads an expired certificate as not current', () => {
    expect(isCurrent(certificate({ expiresOn: '2025-01-01' }), onDate)).toBe(false);
  });

  it('reads a suspended certificate as not current whatever its dates', () => {
    expect(isCurrent(certificate({ suspended: true }), onDate)).toBe(false);
  });

  it('counts the days left', () => {
    expect(daysToExpiry(certificate({ expiresOn: '2025-07-26' }), onDate)).toBe(30);
    expect(daysToExpiry(certificate({ expiresOn: '2025-06-01' }), onDate)).toBeLessThan(0);
  });
});

describe('heldBy', () => {
  const certificates = [
    certificate(),
    certificate({ id: 'cert_2', kind: 'medical', expiresOn: '2025-09-01', endorsements: [] }),
    certificate({ id: 'cert_3', personId: 'per_2', kind: 'competence', endorsements: [] }),
  ];

  it('takes only that person certificates', () => {
    expect(heldBy('per_1', certificates, onDate)).toHaveLength(2);
  });

  it('sorts by what runs out first', () => {
    expect(heldBy('per_1', certificates, onDate)[0].kind).toBe('medical');
  });

  it('gathers the endorsements off the current ones', () => {
    expect(endorsementsFor('per_1', certificates, onDate)).toEqual([
      'bulk_explosive',
      'shock_tube_initiation',
    ]);
  });

  it('drops the endorsements of an expired certificate', () => {
    const lapsed = [certificate({ expiresOn: '2025-01-01' })];
    expect(endorsementsFor('per_1', lapsed, onDate)).toEqual([]);
  });
});

describe('mayFire', () => {
  it('lets a certified shotfirer fire', () => {
    const result = mayFire({ person: shotfirer, certificates: [certificate()], onDate });
    expect(result.valid).toBe(true);
    expect(result.endorsements).toContain('bulk_explosive');
  });

  it('refuses somebody who is not a shotfirer', () => {
    const result = mayFire({ person: driller, certificates: [], onDate });
    expect(result.violations.map((v) => v.rule)).toContain('person.not_a_shotfirer');
  });

  it('refuses somebody with no certificate on file', () => {
    const result = mayFire({ person: shotfirer, certificates: [], onDate });
    expect(result.violations.map((v) => v.rule)).toContain('certificate.missing');
  });

  it('refuses an expired certificate and names the date', () => {
    const result = mayFire({
      person: shotfirer,
      certificates: [certificate({ expiresOn: '2025-01-01' })],
      onDate,
    });
    const expired = result.violations.find((v) => v.rule === 'certificate.expired');
    expect(expired.message).toContain('2025-01-01');
  });

  it('separates a suspension from an expiry', () => {
    const result = mayFire({
      person: shotfirer,
      certificates: [certificate({ suspended: true })],
      onDate,
    });
    expect(result.violations.map((v) => v.rule)).toContain('certificate.suspended');
  });

  it('refuses a lapsed medical even with a good certificate', () => {
    const result = mayFire({
      person: shotfirer,
      certificates: [
        certificate(),
        certificate({ id: 'cert_2', kind: 'medical', expiresOn: '2025-02-01', endorsements: [] }),
      ],
      onDate,
    });
    expect(result.violations.map((v) => v.rule)).toContain('medical.expired');
  });

  it('refuses a shot needing an endorsement the person does not hold', () => {
    const result = mayFire({
      person: shotfirer,
      certificates: [certificate()],
      onDate,
      needs: ['electronic_initiation'],
    });
    expect(result.violations.map((v) => v.rule)).toContain('endorsement.missing');
  });

  it('refuses an inactive employee', () => {
    const gone = parsePerson({ ...shotfirer, active: false });
    const result = mayFire({ person: gone, certificates: [certificate()], onDate });
    expect(result.violations.map((v) => v.rule)).toContain('person.inactive');
  });

  it('reports every reason at once', () => {
    const result = mayFire({
      person: driller,
      certificates: [],
      onDate,
      needs: ['bulk_explosive'],
    });
    expect(result.violations.length).toBeGreaterThan(2);
  });
});

describe('endorsementsNeeded', () => {
  it('works out what a shot needs from the design', () => {
    const needs = endorsementsNeeded({
      products: [{ kind: 'bulk_anfo' }, { kind: 'booster' }],
      detonatorFamilies: ['pyrotechnic'],
    });
    expect(needs).toEqual(['bulk_explosive', 'packaged_explosive', 'shock_tube_initiation']);
  });

  it('asks for the electronic endorsement on an electronic shot', () => {
    expect(endorsementsNeeded({ detonatorFamilies: ['electronic'] })).toEqual([
      'electronic_initiation',
    ]);
  });

  it('asks for secondary breaking when there is any', () => {
    expect(endorsementsNeeded({ secondaryBreaking: true })).toContain('secondary_breaking');
  });

  it('asks for nothing from an empty design', () => {
    expect(endorsementsNeeded({})).toEqual([]);
  });
});

describe('expiringSoon', () => {
  it('picks up what lapses inside the window', () => {
    const certificates = [
      certificate({ expiresOn: '2025-07-10' }),
      certificate({ id: 'cert_2', expiresOn: '2027-01-01' }),
    ];
    expect(expiringSoon(certificates, onDate, 60)).toHaveLength(1);
  });

  it('includes what has already lapsed', () => {
    expect(expiringSoon([certificate({ expiresOn: '2025-01-01' })], onDate)).toHaveLength(1);
  });

  it('sorts the most urgent first', () => {
    const certificates = [
      certificate({ expiresOn: '2025-08-01' }),
      certificate({ id: 'cert_2', expiresOn: '2025-07-01' }),
    ];
    expect(expiringSoon(certificates, onDate, 90)[0].expiresOn).toBe('2025-07-01');
  });
});
