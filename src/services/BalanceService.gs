/**
 * BalanceService.gs — leave balances (LeaveBalances tab).
 *
 *   available = accrued + adjusted − used − pending
 *
 * A request moves days through:  hold (pending) → commit (used)
 *                                 hold (pending) → release        (rejected / cancelled)
 *                                 commit (used)  → revert         (rejected after approval)
 */
const BalanceService = (() => {
  const n = (v) => Number(v) || 0;
  const table = () => Db.table('LeaveBalances');
  const available = (b) => n(b.accrued) + n(b.adjusted) - n(b.used) - n(b.pending);

  const find = (empId, typeId, year) => table().find((b) =>
    b.emp_id === empId && b.type_id === typeId && Number(b.year) === Number(year));

  function findOrCreate(empId, typeId, year) {
    const existing = find(empId, typeId, year);
    if (existing) return existing;
    const t = table();
    return t.insert({
      bal_id: t.nextId('B', 4), emp_id: empId, year: year, type_id: typeId,
      accrued: 0, adjusted: 0, used: 0, pending: 0, available: 0, last_accrual: '', updated_at: DateUtil.now(),
    });
  }

  function change(empId, typeId, year, delta) {
    const b = findOrCreate(empId, typeId, year);
    const next = { used: n(b.used) + n(delta.used), pending: n(b.pending) + n(delta.pending) };
    next.available = available(Object.assign({}, b, next));
    next.updated_at = DateUtil.now();
    return table().update(b.bal_id, next);
  }

  const hold    = (empId, typeId, year, days) => change(empId, typeId, year, { pending: days });
  const release = (empId, typeId, year, days) => change(empId, typeId, year, { pending: -days });
  const commit  = (empId, typeId, year, days) => change(empId, typeId, year, { pending: -days, used: days });
  const revert  = (empId, typeId, year, days) => change(empId, typeId, year, { used: -days });

  /** How many of `days` the balance covers; the rest is Loss of Pay. */
  function split(empId, typeId, year, days) {
    const b = find(empId, typeId, year);
    const free = b ? Math.max(0, available(b)) : 0;
    const paid = Math.min(days, free);
    return { available: free, paid: paid, lop: days - paid };
  }

  /** One entry per active leave type, for the dashboard. */
  function summary(empId, year) {
    return Catalog.leaveTypes().map((lt) => {
      const b = find(empId, lt.type_id, year) || {};
      return {
        type_id: lt.type_id, name: lt.name, code: lt.code, color: lt.color,
        accrued: n(b.accrued), adjusted: n(b.adjusted), used: n(b.used), pending: n(b.pending), available: available(b),
      };
    });
  }

  /** Credit earned so far this year: yearly quota × months active in each quarter up to now. */
  function accruedToDate(person, yearlyQuota, year) {
    const today = DateUtil.today();
    const lastQuarter = DateUtil.year(today) > year ? 4 : DateUtil.quarterOf(today);
    let total = 0;
    for (let q = 1; q <= lastQuarter; q++) {
      const months = DateUtil.monthsActiveInQuarter(person.join_date, person.end_date, year, q);
      total += Math.round((yearlyQuota * months / 12) * 2) / 2;   // nearest half day
    }
    return total;
  }

  /**
   * Makes sure a person has this year's balance rows, credited to date from their policy.
   * Existing rows are left alone (so usage and adjustments are kept).
   * @returns {string[]} what was created
   */
  function ensureYear(person, year) {
    const y = year || DateUtil.year(DateUtil.today());
    const created = [];
    Db.table('Policies').where((r) => r.policy_id === person.policy_id && r.active).forEach((rule) => {
      if (find(person.emp_id, rule.type_id, y)) return;
      const t = table();
      const accrued = accruedToDate(person, n(rule.yearly_quota), y);
      t.insert({
        bal_id: t.nextId('B', 4), emp_id: person.emp_id, year: y, type_id: rule.type_id, accrued: accrued, adjusted: 0,
        used: 0, pending: 0, available: accrued, last_accrual: y + '-Q' + DateUtil.quarterOf(DateUtil.today()), updated_at: DateUtil.now(),
      });
      created.push(person.name + ' ' + rule.type_id + ': ' + accrued + ' days');
    });
    return created;
  }

  /** Manual +/− by an admin. Returns the updated row. */
  function adjust(empId, typeId, year, delta) {
    const b = findOrCreate(empId, typeId, year);
    const next = { adjusted: n(b.adjusted) + delta };
    next.available = available(Object.assign({}, b, next));
    next.updated_at = DateUtil.now();
    return table().update(b.bal_id, next);
  }

  return { hold, release, commit, revert, split, summary, ensureYear, adjust };
})();
