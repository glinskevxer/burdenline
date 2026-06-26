/**
 * Identifier generation.
 *
 * Two kinds of identifier exist in this system and they are not interchangeable.
 * Internal ids are opaque, sortable and prefixed by the kind of record they name,
 * so a mistyped foreign key shows up the moment it is read rather than three
 * joins later. Reference numbers are the things that end up on paper: a shot
 * reference goes on the day-book entry, the regulator notification and the
 * seismograph report, so it has to be short, typeable and stable for the life of
 * the site.
 */

import { AppError } from './errors.js';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const RANDOM_LENGTH = 12;
const TIME_LENGTH = 10;

const KNOWN_PREFIXES = new Set([
  'site',
  'bench',
  'pat',
  'hole',
  'prod',
  'batch',
  'mag',
  'led',
  'det',
  'plan',
  'blast',
  'rec',
  'mon',
  'per',
  'cert',
  'job',
  'rep',
  'evt',
]);

let lastTime = 0;
let sequence = 0;

/**
 * A prefixed, lexicographically sortable id. The time part is the millisecond
 * epoch in base 32, so ids sort by creation order, and a per millisecond counter
 * keeps two ids made in the same tick apart without needing the random tail to
 * carry that weight.
 */
export function newId(prefix, { now = Date.now, random = Math.random } = {}) {
  assertPrefix(prefix);
  const time = now();
  if (time === lastTime) {
    sequence += 1;
  } else {
    lastTime = time;
    sequence = 0;
  }
  const timePart = encodeBase32(time, TIME_LENGTH);
  const seqPart = encodeBase32(sequence % 1024, 2);
  let randomPart = '';
  for (let i = 0; i < RANDOM_LENGTH - 2; i += 1) {
    randomPart += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
  }
  return `${prefix}_${timePart}${seqPart}${randomPart}`;
}

export function isId(value, prefix = null) {
  if (typeof value !== 'string') {
    return false;
  }
  const underscore = value.indexOf('_');
  if (underscore < 1) {
    return false;
  }
  const head = value.slice(0, underscore);
  const tail = value.slice(underscore + 1);
  if (prefix !== null && head !== prefix) {
    return false;
  }
  if (!KNOWN_PREFIXES.has(head)) {
    return false;
  }
  if (tail.length !== TIME_LENGTH + RANDOM_LENGTH) {
    return false;
  }
  return [...tail].every((character) => ALPHABET.includes(character));
}

export function prefixOf(value) {
  if (!isId(value)) {
    throw new AppError(`${value} is not an identifier`, { code: 'bad_id', status: 400 });
  }
  return value.slice(0, value.indexOf('_'));
}

export function assertId(value, prefix) {
  if (!isId(value, prefix)) {
    throw new AppError(`expected a ${prefix} identifier, got ${String(value)}`, {
      code: 'bad_id',
      status: 400,
    });
  }
  return value;
}

/**
 * The human facing shot reference, for example MDW-2025-014. Sequence numbers
 * restart every calendar year, which is how the day-book is audited.
 */
export function shotReference(siteCode, year, sequenceNumber) {
  if (!/^[A-Z]{2,4}$/.test(siteCode)) {
    throw new AppError('a site code is two to four capital letters', {
      code: 'bad_reference',
      status: 400,
    });
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2999) {
    throw new AppError('year out of range for a shot reference', {
      code: 'bad_reference',
      status: 400,
    });
  }
  if (!Number.isInteger(sequenceNumber) || sequenceNumber < 1 || sequenceNumber > 999) {
    throw new AppError('shot sequence runs from 1 to 999 in a year', {
      code: 'bad_reference',
      status: 400,
    });
  }
  return `${siteCode}-${year}-${String(sequenceNumber).padStart(3, '0')}`;
}

export function parseShotReference(reference) {
  const match = /^([A-Z]{2,4})-(\d{4})-(\d{3})$/.exec(String(reference));
  if (!match) {
    throw new AppError(`${reference} is not a shot reference`, {
      code: 'bad_reference',
      status: 400,
    });
  }
  return {
    siteCode: match[1],
    year: Number(match[2]),
    sequence: Number(match[3]),
  };
}

function assertPrefix(prefix) {
  if (!KNOWN_PREFIXES.has(prefix)) {
    throw new AppError(`${prefix} is not a known identifier prefix`, {
      code: 'bad_id',
      status: 500,
    });
  }
}

function encodeBase32(value, length) {
  let out = '';
  let remaining = value;
  for (let i = 0; i < length; i += 1) {
    out = ALPHABET[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

export const idAlphabet = ALPHABET;
