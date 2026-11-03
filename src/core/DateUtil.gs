/**
 * DateUtil.gs — calendar maths on 'yyyy-MM-dd' strings.
 * Pure functions (no sheet access), computed in UTC so time zones never shift a day.
 */
const DateUtil = (() => {
  const DAY_MS = 86400000;

  const today = () => Utilities.formatDate(new Date(), LD_CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const now = () => Utilities.formatDate(new Date(), LD_CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');

  function parse(iso) {
    const p = String(iso).split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }
  const format = (d) => d.toISOString().slice(0, 10);
  const isValid = (iso) => /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) && format(parse(iso)) === iso;
  const addDays = (iso, n) => format(new Date(parse(iso).getTime() + n * DAY_MS));
  const year = (iso) => Number(String(iso).slice(0, 4));
  const quarterOf = (iso) => Math.floor((Number(String(iso).slice(5, 7)) - 1) / 3) + 1;
  /** Inclusive ranges; ISO strings compare correctly as text. */
  const overlaps = (aStart, aEnd, bStart, bEnd) => aStart <= bEnd && bStart <= aEnd;

  /**
   * Leave days between two dates (inclusive).
   * @param {{halfDay?: boolean, holidays?: Object<string,boolean>, weekend?: number[]}} opts
   *        weekend uses JS day numbers (0 = Sunday … 6 = Saturday).
   */
  function workingDays(start, end, opts) {
    const o = opts || {};
    const weekend = o.weekend || [0, 6];
    const holidays = o.holidays || {};
    const isWorking = (iso) => weekend.indexOf(parse(iso).getUTCDay()) === -1 && !holidays[iso];
    if (o.halfDay) return isWorking(start) ? 0.5 : 0;
    let count = 0;
    for (let d = start; d <= end; d = addDays(d, 1)) if (isWorking(d)) count++;
    return count;
  }

  /** Months of quarter q (1–4) in which someone is employed for at least one day. */
  function monthsActiveInQuarter(joinDate, endDate, yr, q) {
    const join = parse(joinDate);
    const end = endDate ? parse(endDate) : null;
    let months = 0;
    for (let m = (q - 1) * 3; m < q * 3; m++) {
      const first = new Date(Date.UTC(yr, m, 1));
      const last = new Date(Date.UTC(yr, m + 1, 0));
      if (join <= last && (!end || end >= first)) months++;
    }
    return months;
  }

  return { today, now, parse, format, isValid, addDays, year, quarterOf, overlaps, workingDays, monthsActiveInQuarter };
})();
