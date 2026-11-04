/**
 * ReportService.gs — leave statistics at three levels: a person, a team, the organization.
 *
 * Who can see what (like Jibble's member / manager / admin):
 *   everyone        → their own report
 *   Team Lead       → + the teams they lead (and each member in them)
 *   C-suite         → + the teams they approve for (and each member)
 *   Admin           → + every team, every person, and the organization
 */
const ReportService = (() => {
  const n = (v) => Number(v) || 0;
  const round1 = (v) => Math.round(v * 10) / 10;

  // ------------------------------------------------------------------ access

  function teamsVisibleTo(viewer, isAdmin) {
    const teams = Db.table('Teams').where((t) => t.active);
    if (isAdmin) return teams;
    return teams.filter((t) => t.lead_id === viewer.emp_id || t.csuite_id === viewer.emp_id);
  }

  /** The report choices for the scope picker. */
  function scopesFor(viewer, isAdmin) {
    const scopes = [{ scope: 'person', id: viewer.emp_id, label: 'Me' }];
    teamsVisibleTo(viewer, isAdmin).forEach((t) => scopes.push({ scope: 'team', id: t.team_id, label: t.team_name }));
    if (isAdmin) scopes.push({ scope: 'org', id: '', label: 'Organization' });
    return scopes;
  }

  function canSeePerson(viewer, isAdmin, empId) {
    if (isAdmin || empId === viewer.emp_id) return true;
    const person = Directory.employee(empId);
    return !!person && teamsVisibleTo(viewer, false).some((t) => t.team_id === person.team_id);
  }

  // ------------------------------------------------------------------ building blocks

  /** Working days of an approved request that fall in each month of `year` (index 0–11). */
  function daysByMonth(request, year, calendar) {
    const months = new Array(12).fill(0);
    if (request.half_day) {
      if (DateUtil.year(request.start_date) === year) months[Number(request.start_date.slice(5, 7)) - 1] += 0.5;
      return months;
    }
    for (let d = request.start_date; d <= request.end_date; d = DateUtil.addDays(d, 1)) {
      if (DateUtil.year(d) !== year) continue;
      if (DateUtil.workingDays(d, d, calendar) > 0) months[Number(d.slice(5, 7)) - 1] += 1;
    }
    return months;
  }

  /** monthly[i] = { month: 'Jan', byType: { LT-PL: 2, LT-SL: 1 }, total } */
  function monthly(requests, year, types) {
    const calendar = Catalog.calendar();
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const rows = names.map((m) => {
      const byType = {};
      types.forEach((t) => { byType[t.type_id] = 0; });
      return { month: m, byType: byType, total: 0 };
    });
    requests.filter((r) => r.status === 'APPROVED').forEach((r) => {
      daysByMonth(r, year, calendar).forEach((days, i) => {
        if (!days) return;
        rows[i].byType[r.type_id] = (rows[i].byType[r.type_id] || 0) + days;
        rows[i].total += days;
      });
    });
    return rows;
  }

  function countByStatus(requests) {
    const c = { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0 };
    requests.forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
    return c;
  }

  function teamInfo(teamId) {
    const t = Directory.team(teamId);
    if (!t) return { team_id: teamId, team_name: '', lead: '', csuite: '' };
    return { team_id: t.team_id, team_name: t.team_name, lead_id: t.lead_id, lead: t.lead_id ? Directory.name(t.lead_id) : '',
      csuite_id: t.csuite_id, csuite: t.csuite_id ? Directory.name(t.csuite_id) : '' };
  }

  /** One row per person: who they are, who approves, and balances. */
  function memberRow(e, year, requestsOfYear) {
    const mine = requestsOfYear.filter((r) => r.emp_id === e.emp_id);
    const approved = mine.filter((r) => r.status === 'APPROVED');
    const team = teamInfo(e.team_id);
    const route = ApprovalRouter.route(Directory.profile(e));
    const approvers = route.some((a) => a.auto) ? 'Auto-approved' : route.map((a) => Directory.name(a.approver_id)).join(' + ') || 'No approver set';
    return {
      approvers: approvers,
      emp_id: e.emp_id, name: e.name, email: e.email, role_level: e.role_level, emp_type: e.emp_type, status: e.status,
      team_id: e.team_id, team_name: team.team_name, lead: team.lead, csuite: team.csuite,
      manager: e.manager_id ? Directory.name(e.manager_id) : '', join_date: e.join_date, end_date: e.end_date,
      balances: BalanceService.summary(e.emp_id, year),
      days_taken: round1(approved.reduce((t, r) => t + n(r.paid_days) + n(r.lop_days), 0)),
      lop_days: round1(approved.reduce((t, r) => t + n(r.lop_days), 0)),
      pending: mine.filter((r) => r.status === 'PENDING').length,
      requests: mine.length,
    };
  }

  function totalsByType(rows, types) {
    return types.map((t) => {
      const sum = (f) => round1(rows.reduce((acc, r) => acc + n((r.balances.find((b) => b.type_id === t.type_id) || {})[f]), 0));
      const credited = round1(sum('accrued') + sum('adjusted'));
      const used = sum('used');
      return { type_id: t.type_id, name: t.name, code: t.code, credited: credited, used: used, pending: sum('pending'),
        available: sum('available'), utilization: credited ? Math.round((used / credited) * 100) : 0 };
    });
  }

  function onLeaveToday(requests, today) {
    return requests
      .filter((r) => r.status === 'APPROVED' && r.start_date <= today && r.end_date >= today)
      .map((r) => ({ emp_id: r.emp_id, name: Directory.name(r.emp_id), type: (Catalog.leaveType(r.type_id) || {}).name || r.type_id, until: r.end_date }));
  }

  function upcoming(requests, today, limit) {
    return requests.filter((r) => r.status === 'APPROVED' && r.start_date > today)
      .sort((a, b) => (a.start_date < b.start_date ? -1 : 1)).slice(0, limit || 10)
      .map((r) => ({ emp_id: r.emp_id, name: Directory.name(r.emp_id), type: (Catalog.leaveType(r.type_id) || {}).name || r.type_id,
        start_date: r.start_date, end_date: r.end_date, days: r.days, half_day: r.half_day }));
  }

  // ------------------------------------------------------------------ reports

  function context() {
    const today = DateUtil.today();
    const year = DateUtil.year(today);
    const types = Catalog.leaveTypes().map((t) => ({ type_id: t.type_id, name: t.name, code: t.code }));
    const requestsOfYear = Db.table('LeaveRequests').where((r) => DateUtil.year(r.start_date) === year);
    return { today, year, types, requestsOfYear };
  }

  function person(empId) {
    const c = context();
    const e = Directory.employee(empId);
    if (!e) throw Errors.notFound('Employee ' + empId);
    const mine = c.requestsOfYear.filter((r) => r.emp_id === empId);
    return {
      scope: 'person', id: empId, year: c.year, today: c.today, types: c.types,
      title: e.name,
      person: memberRow(e, c.year, c.requestsOfYear),
      counts: countByStatus(mine),
      monthly: monthly(mine, c.year, c.types),
      upcoming: upcoming(mine, c.today, 5),
      recent: mine.sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1)).slice(0, 5).map(RequestView.of),
    };
  }

  function group(scope, id, title, members, c, extra) {
    const ids = members.map((e) => e.emp_id);
    const reqs = c.requestsOfYear.filter((r) => ids.indexOf(r.emp_id) !== -1);
    const rows = members.map((e) => memberRow(e, c.year, c.requestsOfYear)).sort((a, b) => (a.name < b.name ? -1 : 1));
    const approved = reqs.filter((r) => r.status === 'APPROVED');
    return Object.assign({
      scope: scope, id: id, year: c.year, today: c.today, types: c.types, title: title,
      stats: {
        members: members.length,
        daysTaken: round1(approved.reduce((t, r) => t + n(r.paid_days) + n(r.lop_days), 0)),
        lopDays: round1(approved.reduce((t, r) => t + n(r.lop_days), 0)),
        onLeaveToday: onLeaveToday(reqs, c.today).length,
      },
      counts: countByStatus(reqs),
      byType: totalsByType(rows, c.types),
      monthly: monthly(reqs, c.year, c.types),
      onLeaveToday: onLeaveToday(reqs, c.today),
      upcoming: upcoming(reqs, c.today, 8),
      members: rows,
    }, extra || {});
  }

  function team(teamId) {
    const c = context();
    const info = teamInfo(teamId);
    if (!info.team_name) throw Errors.notFound('Team ' + teamId);
    const members = Directory.activeEmployees().filter((e) => e.team_id === teamId);
    return group('team', teamId, info.team_name, members, c, { team: info });
  }

  function org() {
    const c = context();
    const people = Directory.activeEmployees();
    const report = group('org', '', Config.get('ORG_NAME', 'Organization'), people, c);
    report.teams = Db.table('Teams').where((t) => t.active).map((t) => {
      const sub = group('team', t.team_id, t.team_name, people.filter((e) => e.team_id === t.team_id), c);
      const all = sub.byType.reduce((a, b) => ({ credited: a.credited + b.credited, used: a.used + b.used }), { credited: 0, used: 0 });
      return Object.assign(teamInfo(t.team_id), {
        members: sub.stats.members, daysTaken: sub.stats.daysTaken, pending: sub.counts.PENDING, lopDays: sub.stats.lopDays,
        onLeaveToday: sub.stats.onLeaveToday, utilization: all.credited ? Math.round((all.used / all.credited) * 100) : 0,
        byType: sub.byType,
      });
    });
    return report;
  }

  /** Entry point with access control. */
  function get(viewer, isAdmin, scope, id) {
    if (scope === 'org') {
      if (!isAdmin) throw Errors.forbidden('Only admins can see the organization report.');
      return org();
    }
    if (scope === 'team') {
      if (!teamsVisibleTo(viewer, isAdmin).some((t) => t.team_id === id)) throw Errors.forbidden('You can only see reports for teams you lead or approve for.');
      return team(id);
    }
    const empId = id || viewer.emp_id;
    if (!canSeePerson(viewer, isAdmin, empId)) throw Errors.forbidden('You can only see reports for yourself and your team members.');
    return person(empId);
  }

  // ------------------------------------------------------------------ download (CSV / PDF)

  const MAX_SPAN_DAYS = 731; // two years

  function checkPeriod(from, to) {
    if (!DateUtil.isValid(from) || !DateUtil.isValid(to)) throw Errors.invalid('Choose a valid From and To date.');
    if (from > to) throw Errors.invalid('"From" must be on or before "To".');
    if (DateUtil.addDays(from, MAX_SPAN_DAYS - 1) < to) throw Errors.invalid('A report can cover at most 2 years.');
  }

  /** Working days of a request that fall between from and to (inclusive). */
  function daysInPeriod(r, from, to, calendar) {
    if (!DateUtil.overlaps(r.start_date, r.end_date, from, to)) return 0;
    if (r.half_day) return r.start_date >= from && r.start_date <= to ? DateUtil.workingDays(r.start_date, r.start_date, Object.assign({}, calendar, { halfDay: true })) : 0;
    return DateUtil.workingDays(r.start_date < from ? from : r.start_date, r.end_date > to ? to : r.end_date, calendar);
  }

  /** Same access rules as the on-screen reports. @returns {{title, people}} */
  function audience(viewer, isAdmin, scope, id) {
    if (scope === 'org') {
      if (!isAdmin) throw Errors.forbidden('Only admins can download the organization report.');
      return { title: Config.get('ORG_NAME', 'Organization'), people: Directory.activeEmployees() };
    }
    if (scope === 'team') {
      if (!teamsVisibleTo(viewer, isAdmin).some((t) => t.team_id === id)) throw Errors.forbidden('You can only download reports for teams you lead or approve for.');
      const info = teamInfo(id);
      return { title: info.team_name, people: Directory.activeEmployees().filter((e) => e.team_id === id) };
    }
    const empId = id || viewer.emp_id;
    if (!canSeePerson(viewer, isAdmin, empId)) throw Errors.forbidden('You can only download reports for yourself and your team members.');
    const e = Directory.employee(empId);
    if (!e) throw Errors.notFound('Employee ' + empId);
    return { title: e.name, people: [e] };
  }

  const ROLE_LABEL = { CSUITE: 'C-suite', LEAD: 'Team Lead', EMPLOYEE: 'Employee' };
  const TYPE_LABEL = { FT: 'Full-time', INT: 'Intern', CON: 'Contractor' };
  const STATUS_LABEL = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };
  const slug = (v) => String(v || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';

  /**
   * Report data for a period, as two tables (Summary, Leave requests).
   * The browser turns it into a CSV file (opens in Excel / Google Sheets) or a printable PDF.
   * Requests are included when any of their days fall in the period. Balances are for the
   * leave year of the "To" date (never later than this year).
   */
  function exportData(viewer, isAdmin, scope, id, from, to) {
    scope = scope || 'person';
    checkPeriod(from, to);
    const who = audience(viewer, isAdmin, scope, id);
    const today = DateUtil.today();
    const balanceYear = Math.min(DateUtil.year(to), DateUtil.year(today));
    const calendar = Catalog.calendar();
    const types = Catalog.leaveTypes().map((t) => ({ type_id: t.type_id, name: t.name, code: t.code }));
    const people = who.people.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
    const ids = {};
    people.forEach((e) => { ids[e.emp_id] = e; });
    const reqs = Db.table('LeaveRequests')
      .where((r) => ids[r.emp_id] && DateUtil.overlaps(r.start_date, r.end_date, from, to))
      .sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : (a.emp_id < b.emp_id ? -1 : 1)));
    const typeName = (tid) => (Catalog.leaveType(tid) || {}).name || tid;
    const inPeriod = {};
    reqs.forEach((r) => { inPeriod[r.req_id] = daysInPeriod(r, from, to, calendar); });

    // Summary: one row per person
    const col = (key, label, pdf) => ({ key: key, label: label, pdf: !!pdf });
    const summaryCols = [col('emp_id', 'Employee ID'), col('name', 'Name', true), col('email', 'Email'), col('team', 'Team', scope !== 'person'),
      col('role', 'Role'), col('type', 'Employment type'), col('approvers', 'Leave approved by', true)];
    types.forEach((t) => {
      summaryCols.push(col(t.code + '_credited', t.code + ' credited ' + balanceYear, true), col(t.code + '_used', t.code + ' used ' + balanceYear),
        col(t.code + '_pending', t.code + ' pending ' + balanceYear), col(t.code + '_left', t.code + ' left ' + balanceYear, true));
    });
    summaryCols.push(col('days', 'Approved leave days in period', true), col('lop', 'LOP days (approved requests in period)', true),
      col('pending', 'Pending requests', true), col('rejected', 'Rejected requests'), col('cancelled', 'Cancelled requests'));

    const summaryRows = people.map((e) => {
      const row = memberRow(e, balanceYear, []);
      const mine = reqs.filter((r) => r.emp_id === e.emp_id);
      const approved = mine.filter((r) => r.status === 'APPROVED');
      const v = { emp_id: e.emp_id, name: e.name, email: e.email, team: row.team_name, role: ROLE_LABEL[e.role_level] || e.role_level, type: TYPE_LABEL[e.emp_type] || e.emp_type, approvers: row.approvers };
      types.forEach((t) => {
        const b = row.balances.find((x) => x.type_id === t.type_id) || {};
        v[t.code + '_credited'] = round1(n(b.accrued) + n(b.adjusted));
        v[t.code + '_used'] = round1(n(b.used));
        v[t.code + '_pending'] = round1(n(b.pending));
        v[t.code + '_left'] = round1(n(b.available));
      });
      v.days = round1(approved.reduce((t, r) => t + inPeriod[r.req_id], 0));
      v.lop = round1(approved.reduce((t, r) => t + n(r.lop_days), 0));
      v.pending = mine.filter((r) => r.status === 'PENDING').length;
      v.rejected = mine.filter((r) => r.status === 'REJECTED').length;
      v.cancelled = mine.filter((r) => r.status === 'CANCELLED').length;
      return summaryCols.map((c) => v[c.key]);
    });

    // Leave requests in the period
    const reqCols = [col('req_id', 'Request ID'), col('emp_id', 'Employee ID'), col('name', 'Name', true), col('team', 'Team', scope !== 'person'),
      col('type', 'Leave type', true), col('start', 'Start', true), col('end', 'End', true), col('half', 'Half day'),
      col('days', 'Working days'), col('in_period', 'Days in period', true), col('paid', 'Paid days'), col('lop', 'LOP days', true),
      col('status', 'Status', true), col('by', 'Decided by', true), col('at', 'Decided at'), col('submitted', 'Submitted at'), col('reason', 'Reason')];
    const reqRows = reqs.map((r) => {
      const e = ids[r.emp_id];
      const v = { req_id: r.req_id, emp_id: r.emp_id, name: e.name, team: teamInfo(e.team_id).team_name, type: typeName(r.type_id),
        start: r.start_date, end: r.end_date, half: r.half_day ? 'Yes' : 'No', days: n(r.days), in_period: inPeriod[r.req_id],
        paid: n(r.paid_days), lop: n(r.lop_days), status: STATUS_LABEL[r.status] || r.status,
        by: r.final_by === 'SYSTEM' ? 'Auto-approved' : r.final_by ? Directory.name(r.final_by) : '',
        at: r.final_at || '', submitted: r.submitted_at || '', reason: r.reason || '' };
      return reqCols.map((c) => v[c.key]);
    });

    return {
      scope: scope, id: id || '', title: who.title, from: from, to: to, balanceYear: balanceYear,
      generatedAt: DateUtil.now(), generatedBy: viewer.name,
      filename: 'leave-report_' + slug(who.title) + '_' + from + '_to_' + to,
      totals: { people: people.length, requests: reqs.length,
        approvedDays: round1(summaryRows.reduce((t, r) => t + n(r[summaryCols.findIndex((c) => c.key === 'days')]), 0)) },
      tables: [
        { name: 'Summary', note: 'Balances are for the ' + balanceYear + ' leave year. Days in period count working days only.', columns: summaryCols, rows: summaryRows },
        { name: 'Leave requests', note: 'Every request with at least one day between ' + from + ' and ' + to + '.', columns: reqCols, rows: reqRows },
      ],
    };
  }

  return { scopesFor, get, org, team, person, exportData };
})();
