/**
 * Catalog.gs — reference data: leave types, holidays, weekend days.
 */
const Catalog = (() => {
  const DAY_INDEX = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

  const leaveType = (id) => Db.table('LeaveTypes').get(id);

  const leaveTypes = () => Db.table('LeaveTypes')
    .where((t) => t.active)
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order));

  const holidays = (year) => Db.table('Holidays')
    .where((h) => !h.optional && (!year || DateUtil.year(h.date) === year))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  function holidaySet() {
    const set = {};
    holidays().forEach((h) => { set[h.date] = true; });
    return set;
  }

  const weekendDays = () => Config.list('WEEKEND_DAYS')
    .map((d) => DAY_INDEX[d.toUpperCase().slice(0, 3)])
    .filter((n) => n !== undefined);

  /** Everything DateUtil.workingDays needs to count leave days. */
  const calendar = () => ({ holidays: holidaySet(), weekend: weekendDays() });

  return { leaveType, leaveTypes, holidays, calendar };
})();
