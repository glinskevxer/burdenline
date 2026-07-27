/**
 * Schema fragments used by more than one route.
 *
 * The period query was written out in four route files and two of them had the
 * minimum length on the dates and two did not, so the same missing parameter was
 * a 422 on one report and an empty answer on another. Anything a caller sees the
 * shape of on two routes belongs here.
 */

export const periodQuery = Object.freeze({
  type: 'object',
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', minLength: 4 },
    to: { type: 'string', minLength: 4 },
  },
});

export const reasonBody = Object.freeze({
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } },
});

export const outcomeBody = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: { outcome: { type: 'string', minLength: 5, maxLength: 1000 } },
});

/** The shape of a laid out pattern, which the design and what-if routes both take. */
export const designShape = Object.freeze({
  type: 'object',
  required: [
    'faceBearingDeg',
    'rowCount',
    'holesPerRow',
    'burdenM',
    'spacingM',
    'benchHeightM',
    'diameterMm',
    'origin',
  ],
  additionalProperties: false,
  properties: {
    origin: {
      type: 'object',
      required: ['easting', 'northing', 'level'],
      additionalProperties: false,
      properties: {
        easting: { type: 'number' },
        northing: { type: 'number' },
        level: { type: 'number' },
      },
    },
    faceBearingDeg: { type: 'number', minimum: 0, exclusiveMaximum: 360 },
    layout: { type: 'string', enum: ['square', 'staggered', 'single_row'] },
    rowCount: { type: 'integer', minimum: 1, maximum: 20 },
    holesPerRow: { type: 'integer', minimum: 1, maximum: 200 },
    burdenM: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
    spacingM: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
    benchHeightM: { type: 'number', exclusiveMinimum: 0, maximum: 60 },
    subdrillM: { type: 'number', minimum: 0, maximum: 6 },
    inclinationDeg: { type: 'number', minimum: 0, maximum: 45 },
    diameterMm: { type: 'number', minimum: 25, maximum: 400 },
  },
});

/** The tie-in, which the timing and design routes both take. */
export const tieInSchema = Object.freeze({
  type: 'object',
  required: ['initiationHole', 'holes'],
  additionalProperties: false,
  properties: {
    initiationHole: { type: 'integer', minimum: 1 },
    trunklineDelayMs: { type: 'number', minimum: 0 },
    holes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['holeNumber', 'inHoleDelayMs'],
        additionalProperties: false,
        properties: {
          holeNumber: { type: 'integer', minimum: 1 },
          inHoleDelayMs: { type: 'number', minimum: 0 },
          deckDelaysMs: { type: 'array', items: { type: 'number', minimum: 0 } },
        },
      },
    },
    connectors: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fromHole', 'toHole', 'delayMs'],
        additionalProperties: false,
        properties: {
          fromHole: { type: 'integer', minimum: 1 },
          toHole: { type: 'integer', minimum: 1 },
          delayMs: { type: 'number', minimum: 0 },
        },
      },
    },
  },
});
