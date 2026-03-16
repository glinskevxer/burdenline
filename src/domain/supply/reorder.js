/**
 * When to order more.
 *
 * A quarry runs out of anfo on the morning of a shot, not gradually, and the
 * reason is always the same: consumption is lumpy, the lead time is a week, and
 * the person watching the level is watching it against a number somebody wrote
 * on the wall in 2019.
 *
 * This works the number out from what has actually been used. The reorder point
 * is what will be consumed during the lead time plus a buffer for the fact that
 * consumption varies, and the buffer is taken from the variation in the history
 * rather than being a flat percentage, because a site that fires the same shot
 * every week needs far less cover than one that fires twice a month at random.
 */

import { roundTo } from '../../lib/units.js';
import { requirePositive, requireNonNegative } from '../../lib/guards.js';
import { ValidationError } from '../../lib/errors.js';

export const DEFAULT_SUPPLY_RULES = Object.freeze({
  leadTimeDays: 7,
  coverDays: 21,
  serviceFactor: 1.64,
  minimumHistoryDays: 30,
});

/** Average daily use and how much it varies, from the consumption history. */
export function consumptionProfile(usage, { days } = {}) {
  if (!Array.isArray(usage) || usage.length === 0) {
    return { days: days ?? 0, total: 0, perDay: 0, deviation: 0, entries: 0 };
  }
  const total = roundTo(
    usage.reduce((sum, entry) => sum + entry.quantity, 0),
    3,
  );
  const spanDays = days ?? distinctDays(usage);
  requirePositive(spanDays, 'days');
  const perDay = roundTo(total / spanDays, 4);
  const byDay = new Map();
  for (const entry of usage) {
    byDay.set(entry.on, roundTo((byDay.get(entry.on) ?? 0) + entry.quantity, 3));
  }
  const daily = [...byDay.values()];
  const mean = daily.reduce((sum, value) => sum + value, 0) / Math.max(daily.length, 1);
  const variance =
    daily.length > 1
      ? daily.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (daily.length - 1)
      : 0;
  return {
    days: spanDays,
    total,
    perDay,
    deviation: roundTo(Math.sqrt(variance), 4),
    entries: usage.length,
    busiestDay: daily.length ? roundTo(Math.max(...daily), 3) : 0,
  };
}

export function reorderPoint({ profile, rules = DEFAULT_SUPPLY_RULES }) {
  requirePositive(rules.leadTimeDays, 'leadTimeDays');
  const duringLeadTime = profile.perDay * rules.leadTimeDays;
  const buffer = rules.serviceFactor * profile.deviation * Math.sqrt(rules.leadTimeDays);
  return {
    duringLeadTime: roundTo(duringLeadTime, 2),
    buffer: roundTo(buffer, 2),
    reorderAt: roundTo(duringLeadTime + buffer, 2),
    coverTo: roundTo(profile.perDay * rules.coverDays + buffer, 2),
  };
}

/**
 * What to do about one product: nothing, order, or order urgently because the
 * stock will not last the lead time.
 */
export function assessStock({
  productCode,
  held,
  onOrder = 0,
  profile,
  rules = DEFAULT_SUPPLY_RULES,
}) {
  requireNonNegative(held, 'held');
  requireNonNegative(onOrder, 'onOrder');
  const point = reorderPoint({ profile, rules });
  const available = roundTo(held + onOrder, 3);
  const daysOfCover = profile.perDay > 0 ? roundTo(available / profile.perDay, 1) : null;
  const shortfall = roundTo(Math.max(point.coverTo - available, 0), 2);
  let action = 'none';
  if (available <= point.duringLeadTime) {
    action = 'urgent';
  } else if (available <= point.reorderAt) {
    action = 'order';
  }
  return {
    productCode,
    held,
    onOrder,
    available,
    daysOfCover,
    reorderAt: point.reorderAt,
    coverTo: point.coverTo,
    suggestedQuantity: action === 'none' ? 0 : shortfall,
    action,
    note:
      profile.days < rules.minimumHistoryDays
        ? `only ${profile.days} days of history, treat the suggestion as a guess`
        : null,
  };
}

/** The whole store, worst first, which is what an ordering screen shows. */
export function reviewStore({ items, rules = DEFAULT_SUPPLY_RULES }) {
  if (!Array.isArray(items)) {
    throw new ValidationError('a store review needs the items in it', [
      { path: 'items', message: 'expected a list', kind: 'type' },
    ]);
  }
  const assessed = items.map((item) =>
    assessStock({
      productCode: item.productCode,
      held: item.held,
      onOrder: item.onOrder ?? 0,
      profile: item.profile ?? consumptionProfile(item.usage ?? [], { days: item.days }),
      rules,
    }),
  );
  const order = { urgent: 0, order: 1, none: 2 };
  assessed.sort(
    (a, b) => order[a.action] - order[b.action] || (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9),
  );
  return {
    items: assessed,
    toOrder: assessed.filter((item) => item.action !== 'none'),
    urgent: assessed.filter((item) => item.action === 'urgent').length,
  };
}

function distinctDays(usage) {
  const days = new Set(usage.map((entry) => entry.on));
  if (days.size <= 1) {
    return 1;
  }
  const sorted = [...days].sort();
  const first = Date.parse(`${sorted[0]}T00:00:00Z`);
  const last = Date.parse(`${sorted.at(-1)}T00:00:00Z`);
  return Math.max(Math.round((last - first) / 86400000) + 1, 1);
}
