/**
 * AdminService.gs — the admin dashboard: org-wide numbers, every request, every balance.
 * Read-only. Adding/editing people, teams and policies is the next phase.
 */
const AdminService = (() => {
  const n = (v) => Number(v) || 0;
  const sum = (list, field) => list.reduce((t, r) => t + n(r[field]), 0);

  function overview() {
    const today = DateUtil.today();
    const year = DateUtil.year(today);
    const all = Db.table('LeaveRequests').all();
    const thisYear = all.filter((r) => DateUtil.year(r.start_date) === year);
    const approved = thisYear.filter((r) => r.status === 'APPROVED');
    const count = (status) => thisYear.filter((r) => r.status === status).length;
    const people = Directory.activeEmployees();

    const onLeaveToday = approved
      .filter((r) => r.start_date <= today && r.end_date >= today)
      .map((r) => ({ name: Directory.name(r.emp_id), type: (Catalog.leaveType(r.type_id) || {}).name || r.type_id, until: r.end_date }));

    const balances = people.map((e) => {
      const profile = Directory.profile(e);
      return {
        emp_id: e.emp_id, name: e.name, team_name: profile.team_name, role_level: e.role_level, emp_type: e.emp_type,
        balances: BalanceService.summary(e.emp_id, year).map((b) => ({
          type_id: b.type_id, code: b.code, available: b.available, credited: b.accrued + b.adjusted, used: b.used, pending: b.pending,
        })),
        lop_days: sum(approved.filter((r) => r.emp_id === e.emp_id), 'lop_days'),
      };
    }).sort((a, b) => (a.team_name + a.name < b.team_name + b.name ? -1 : 1));

    return {
      year: year,
      today: today,
      stats: {
        people: people.length, pending: count('PENDING'), approved: count('APPROVED'), rejected: count('REJECTED'),
        daysTaken: sum(approved, 'days'), lopDays: sum(approved, 'lop_days'), onLeaveToday: onLeaveToday.length,
      },
      onLeaveToday: onLeaveToday,
      leaveTypes: Catalog.leaveTypes().map((t) => ({ type_id: t.type_id, code: t.code, name: t.name, color: t.color })),
      requests: all.sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1)).slice(0, 100).map(RequestView.of),
      balances: balances,
    };
  }

  return { overview };
})();
