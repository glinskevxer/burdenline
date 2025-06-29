/**
 * Who is allowed to do what.
 *
 * A shot is fired by a named shotfirer holding a current certificate, and the
 * certificate is endorsed for particular things: the classes of explosive, the
 * initiation systems, and whether the holder may sign a design off as well as
 * fire it. Certificates expire, and a certificate that expired yesterday is not
 * a paperwork problem, it is the difference between a legal blast and an illegal
 * one, so this refuses rather than warns.
 *
 * Medical and refresher training sit alongside the certificate with their own
 * dates, because a shotfirer whose refresher has lapsed keeps the certificate
 * but stops being usable on the bench.
 */

import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import { collector } from '../violations.js';

export const ROLES = ['shotfirer', 'designer', 'charge_hand', 'driller', 'sentry', 'manager'];

export const ENDORSEMENTS = [
  'bulk_explosive',
  'packaged_explosive',
  'electronic_initiation',
  'shock_tube_initiation',
  'electric_initiation',
  'design_approval',
  'secondary_breaking',
];

export const personSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(2).max(80),
  roles: z
    .array(z.enum(['shotfirer', 'designer', 'charge_hand', 'driller', 'sentry', 'manager']))
    .min(1),
  employer: z.string().max(80).nullable().default(null),
  active: z.boolean().default(true),
});

export const certificateSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  kind: z.enum(['shotfirer', 'medical', 'refresher', 'competence']),
  reference: z.string().max(40).nullable().default(null),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endorsements: z.array(z.string()).default([]),
  suspended: z.boolean().default(false),
});

export function parsePerson(input) {
  const parsed = personSchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the person record is not usable');
  }
  return Object.freeze(parsed.data);
}

export function parseCertificate(input) {
  const parsed = certificateSchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the certificate is not usable');
  }
  const certificate = parsed.data;
  if (certificate.expiresOn <= certificate.issuedOn) {
    throw new ValidationError('a certificate cannot expire before it was issued', [
      { path: 'expiresOn', message: 'expiry is not after issue', kind: 'range' },
    ]);
  }
  for (const endorsement of certificate.endorsements) {
    if (!ENDORSEMENTS.includes(endorsement)) {
      throw new ValidationError(`${endorsement} is not an endorsement`, [
        {
          path: 'endorsements',
          message: `expected one of ${ENDORSEMENTS.join(', ')}`,
          kind: 'enum',
        },
      ]);
    }
  }
  return Object.freeze(certificate);
}

export function isCurrent(certificate, onDate) {
  if (certificate.suspended) {
    return false;
  }
  return certificate.issuedOn <= onDate && certificate.expiresOn >= onDate;
}

export function daysToExpiry(certificate, onDate) {
  return Math.floor(
    (Date.parse(`${certificate.expiresOn}T00:00:00Z`) - Date.parse(`${onDate}T00:00:00Z`)) /
      86400000,
  );
}

/** Everything a person currently holds, sorted by what runs out first. */
export function heldBy(personId, certificates, onDate) {
  return certificates
    .filter((certificate) => certificate.personId === personId)
    .map((certificate) => ({
      ...certificate,
      current: isCurrent(certificate, onDate),
      daysRemaining: daysToExpiry(certificate, onDate),
    }))
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}

export function endorsementsFor(personId, certificates, onDate) {
  const held = new Set();
  for (const certificate of heldBy(personId, certificates, onDate)) {
    if (certificate.current) {
      for (const endorsement of certificate.endorsements) {
        held.add(endorsement);
      }
    }
  }
  return [...held].sort();
}

/**
 * May this person fire this shot? Every reason it is not allowed comes back at
 * once, because the answer goes on a screen in front of a supervisor who needs
 * to know what to fix, not the first thing that failed.
 */
export function mayFire({ person, certificates, onDate, needs = [] }) {
  const found = collector();
  if (!person.active) {
    found.add('person.inactive', `${person.name} is not an active employee`, {
      personId: person.id,
    });
  }
  if (!person.roles.includes('shotfirer')) {
    found.add('person.not_a_shotfirer', `${person.name} is not a shotfirer`, {
      personId: person.id,
    });
  }
  const held = heldBy(person.id, certificates, onDate);
  const shotfirer = held.find((certificate) => certificate.kind === 'shotfirer');
  if (!shotfirer) {
    found.add('certificate.missing', `${person.name} has no shotfirer certificate on file`, {
      personId: person.id,
    });
  } else if (!shotfirer.current) {
    found.add(
      shotfirer.suspended ? 'certificate.suspended' : 'certificate.expired',
      `the shotfirer certificate for ${person.name} ${shotfirer.suspended ? 'is suspended' : `expired on ${shotfirer.expiresOn}`}`,
      { personId: person.id, certificateId: shotfirer.id },
    );
  }
  for (const kind of ['medical', 'refresher']) {
    const certificate = held.find((item) => item.kind === kind);
    if (certificate && !certificate.current) {
      found.add(
        `${kind}.expired`,
        `the ${kind} for ${person.name} expired on ${certificate.expiresOn}`,
        {
          personId: person.id,
        },
      );
    }
  }
  const endorsed = endorsementsFor(person.id, certificates, onDate);
  for (const needed of needs) {
    if (!endorsed.includes(needed)) {
      found.add('endorsement.missing', `${person.name} is not endorsed for ${needed}`, {
        personId: person.id,
        endorsement: needed,
      });
    }
  }
  return found.result({ personId: person.id, endorsements: endorsed });
}

/** What a shot needs from whoever fires it, worked out from the design. */
export function endorsementsNeeded({
  products = [],
  detonatorFamilies = [],
  secondaryBreaking = false,
}) {
  const needs = new Set();
  for (const product of products) {
    if (['bulk_anfo', 'bulk_emulsion', 'bulk_blend'].includes(product.kind)) {
      needs.add('bulk_explosive');
    }
    if (['packaged_emulsion', 'cartridge', 'booster'].includes(product.kind)) {
      needs.add('packaged_explosive');
    }
  }
  for (const family of detonatorFamilies) {
    needs.add(family === 'electronic' ? 'electronic_initiation' : 'shock_tube_initiation');
  }
  if (secondaryBreaking) {
    needs.add('secondary_breaking');
  }
  return [...needs].sort();
}

/** Certificates that will lapse soon, which is what the monthly sweep reads. */
export function expiringSoon(certificates, onDate, withinDays = 60) {
  return certificates
    .map((certificate) => ({ ...certificate, daysRemaining: daysToExpiry(certificate, onDate) }))
    .filter((certificate) => certificate.daysRemaining <= withinDays)
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}
