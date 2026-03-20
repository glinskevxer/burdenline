/**
 * The drill fleet and what it did each shift.
 *
 * A rig is matched to a pattern by hole diameter, which is the constraint that
 * actually bites: sending the 89 millimetre rig to a pattern designed at 115 is
 * a wasted morning, and it happens because the plan says the pattern and the
 * roster says the rig and nothing checks the two against each other.
 *
 * Shift records are one per rig per shift per day and they carry downtime, so
 * the metres per hour figure that comes out of them is metres per drilling hour
 * rather than metres per hour of standing about.
 */

import { ConflictError, ValidationError } from '../../lib/errors.js';
import { getById, listWhere, createRecord, updateRecord } from '../repository.js';
import { roundTo } from '../../lib/units.js';
import { selectWhere } from '../query.js';

export const RIG_STATES = ['available', 'drilling', 'maintenance', 'down', 'retired'];
export const SHIFTS = ['day', 'back', 'night'];

export function createRig(db, input, { clock }) {
  getById(db, 'site', input.siteId, { kind: 'site' });
  if (input.holeDiameterMaxMm < input.holeDiameterMinMm) {
    throw new ValidationError('a rig diameter range runs from small to large', [
      { path: 'holeDiameterMaxMm', message: 'the maximum is under the minimum', kind: 'range' },
    ]);
  }
  return createRecord(
    db,
    {
      table: 'drill_rig',
      prefix: 'per',
      defaults: { make: null, model: null, status: 'available', hoursRun: 0 },
    },
    {
      siteId: input.siteId,
      fleetNumber: input.fleetNumber,
      make: input.make,
      model: input.model,
      holeDiameterMinMm: input.holeDiameterMinMm,
      holeDiameterMaxMm: input.holeDiameterMaxMm,
      status: input.status,
    },
    { clock },
  );
}

export function getRig(db, id) {
  return getById(db, 'drill_rig', id, { kind: 'rig' });
}

export function listRigs(db, siteId, options = {}) {
  return listWhere(
    db,
    'drill_rig',
    { siteId, status: options.status },
    { orderBy: 'fleet_number' },
  );
}

export function updateRig(db, id, changes, { clock }) {
  return updateRecord(
    db,
    {
      table: 'drill_rig',
      kind: 'rig',
      updatable: ['make', 'model', 'holeDiameterMinMm', 'holeDiameterMaxMm', 'status', 'hoursRun'],
    },
    id,
    changes,
    { clock },
  );
}

/** Which rigs can drill this pattern, and why the others cannot. */
export function rigsForPattern(db, patternId) {
  const pattern = getById(db, 'pattern', patternId, { kind: 'pattern' });
  const bench = getById(db, 'bench', pattern.benchId, { kind: 'bench' });
  return listRigs(db, bench.siteId).map((rig) => {
    const reasons = [];
    if (
      pattern.holeDiameterMm < rig.holeDiameterMinMm ||
      pattern.holeDiameterMm > rig.holeDiameterMaxMm
    ) {
      reasons.push(
        `${rig.fleetNumber} drills ${rig.holeDiameterMinMm} to ${rig.holeDiameterMaxMm} mm and the pattern is ${pattern.holeDiameterMm} mm`,
      );
    }
    if (!['available', 'drilling'].includes(rig.status)) {
      reasons.push(`${rig.fleetNumber} is ${rig.status}`);
    }
    return { rig, suitable: reasons.length === 0, reasons };
  });
}

export function recordShift(db, input, { clock }) {
  const rig = getRig(db, input.rigId);
  if (input.patternId) {
    getById(db, 'pattern', input.patternId, { kind: 'pattern' });
  }
  if (!SHIFTS.includes(input.shift)) {
    throw new ValidationError(`${input.shift} is not a shift anybody works`, [
      { path: 'shift', message: `expected one of ${SHIFTS.join(', ')}`, kind: 'enum' },
    ]);
  }
  const written = createRecord(
    db,
    {
      table: 'drill_shift',
      prefix: 'job',
      timestamps: ['createdAt'],
      defaults: {
        patternId: null,
        operatorId: null,
        metresDrilled: 0,
        holesDrilled: 0,
        downtimeMinutes: 0,
        downtimeReason: null,
      },
    },
    {
      rigId: rig.id,
      patternId: input.patternId,
      shiftDate: input.shiftDate ?? clock.date(),
      shift: input.shift,
      operatorId: input.operatorId,
      metresDrilled: input.metresDrilled,
      holesDrilled: input.holesDrilled,
      hours: input.hours,
      downtimeMinutes: input.downtimeMinutes,
      downtimeReason: input.downtimeReason,
    },
    { clock },
  );
  updateRig(db, rig.id, { hoursRun: roundTo(rig.hoursRun + input.hours, 2) }, { clock });
  return written;
}

export function listShifts(db, rigId, { from, to } = {}) {
  return selectWhere(db, {
    table: 'drill_shift',
    where: { rigId },
    between: { column: 'shiftDate', from, to },
    orderBy: 'shift_date, shift',
    limit: 500,
  });
}

/** Metres per drilling hour, and how much of the shift was spent drilling. */
export function rigProductivity(db, rigId, period = {}) {
  const shifts = listShifts(db, rigId, period);
  if (shifts.length === 0) {
    return { shifts: 0, metres: 0, holes: 0, hours: 0, metresPerHour: null, availability: null };
  }
  const metres = roundTo(
    shifts.reduce((sum, shift) => sum + shift.metresDrilled, 0),
    2,
  );
  const hours = roundTo(
    shifts.reduce((sum, shift) => sum + shift.hours, 0),
    2,
  );
  const downtime = roundTo(
    shifts.reduce((sum, shift) => sum + shift.downtimeMinutes, 0),
    1,
  );
  const drilling = hours - downtime / 60;
  return {
    shifts: shifts.length,
    metres,
    holes: shifts.reduce((sum, shift) => sum + shift.holesDrilled, 0),
    hours,
    downtimeMinutes: downtime,
    metresPerHour: drilling > 0 ? roundTo(metres / drilling, 2) : null,
    availability: hours > 0 ? roundTo(drilling / hours, 4) : null,
    downtimeByReason: shifts
      .filter((shift) => shift.downtimeMinutes > 0)
      .reduce((tally, shift) => {
        const reason = shift.downtimeReason ?? 'not recorded';
        tally[reason] = roundTo((tally[reason] ?? 0) + shift.downtimeMinutes, 1);
        return tally;
      }, {}),
  };
}

export function retireRig(db, id, { clock }) {
  const rig = getRig(db, id);
  if (rig.status === 'retired') {
    throw new ConflictError('that rig is already retired', { rigId: id });
  }
  return updateRig(db, id, { status: 'retired' }, { clock });
}
