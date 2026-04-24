/**
 * Date helpers — Kuwait time zone (Asia/Kuwait, UTC+3, no DST).
 *
 * Workers run in UTC, so we use Intl.DateTimeFormat to project into
 * Kuwait wallclock time instead of the brittle `toLocaleString` round-trip
 * that was previously scattered through the codebase.
 */

const KUWAIT_TZ = 'Asia/Kuwait';

/**
 * Return the wallclock date in Kuwait for the given instant.
 *   { year, month (1-12), day (1-31), weekday ('Sat' | 'Sun' | ...) }
 */
export function getKuwaitDateParts(instant = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: KUWAIT_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
  const parts = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    weekday: parts.weekday,
  };
}

/**
 * Return a Date anchored at noon UTC on the Kuwait wallclock date.
 * Safe to call getUTCDate/getDate/getDay on the result — they match the
 * Kuwait day since noon UTC = 15:00 Kuwait (same calendar day).
 */
export function dateFromKuwaitParts({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

/**
 * Next publishing day for AlJarida (tomorrow in Kuwait, skip Saturday).
 * Returned Date is anchored at noon UTC on the target Kuwait date so
 * getFullYear/getMonth/getDate/getDay all match Kuwait wallclock.
 */
export function getNextPublishingDate(now = new Date()) {
  const today = getKuwaitDateParts(now);
  let target = dateFromKuwaitParts({ year: today.year, month: today.month, day: today.day + 1 });
  if (getKuwaitDateParts(target).weekday === 'Sat') {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  }
  return target;
}
