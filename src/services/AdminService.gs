/**
 * AdminService.gs — everything the admin can see and change.
 *
 *  overview()        dashboard data: organization report, people directory, teams,
 *                    every request, leave policies
 *  savePerson()      add or edit an employee (info, role, type, team, dates, status)
 *  saveTeam()        add or edit a team (name, team lead, C-suite approver)
 *  adjustBalance()   add or remove leave days for one person (reason required)
 *  saveQuota()       change a policy's yearly quota
 *
 * Derived fields keep the approval chain correct automatically:
 *   employee's manager = their team's lead · lead's manager = their team's C-suite
 * Every change is written to AuditLog.
 */
const AdminService = (() => {
  const POLICY_FOR = { FT: 'P-FT', INT: 'P-INT', CON: 'P-CON' };
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const DATE_OK = (v) => !v || DateUtil.isValid(v);
  const clean = (v) => String(v === undefined || v === null ? '' : v).trim();

  // ------------------------------------------------------------------ read

  function overview() {
    const report = ReportService.org();
    const everyone = Db.table('Employees').all();
    const pendingOf = (empId) => Db.table('LeaveRequests').where((r) => r.emp_id === empId && r.status === 'PENDING').length;
    return {
      report: report,
      people: everyone.map((e) => report.members.find((m) => m.emp_id === e.emp_id) || inactiveRow(e, report.year, pendingOf))
        .sort((a, b) => (a.status === b.status ? (a.name < b.name ? -1 : 1) : (a.status === 'Active' ? -1 : 1))),
      teams: Db.table('Teams').all().map((t) => Object.assign({}, t, {
        lead: t.lead_id ? Directory.name(t.lead_id) : '', csuite: t.csuite_id ? Directory.name(t.csuite_id) : '',
        members: everyone.filter((e) => e.team_id === t.team_id && e.status === 'Active')
          .map((e) => ({ emp_id: e.emp_id, name: e.name, role_level: e.role_level, emp_type: e.emp_type })),
      })),
      requests: Db.table('LeaveRequests').all().sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1)).slice(0, 150).map(RequestView.of),
      policies: Db.table('Policies').all().map((p) => Object.assign({}, p, { type_name: (Catalog.leaveType(p.type_id) || {}).name || p.type_id })),
      leaveTypes: Catalog.leaveTypes().map((t) => ({ type_id: t.type_id, name: t.name, code: t.code })),
    };
  }

  /** Inactive people aren't in the org report; give them the same row shape. */
  function inactiveRow(e, year, pendingOf) {
    const team = Directory.team(e.team_id);
    return {
      approvers: '—',
      emp_id: e.emp_id, name: e.name, email: e.email, role_level: e.role_level, emp_type: e.emp_type, status: e.status,
      team_id: e.team_id, team_name: team ? team.team_name : '', lead: team && team.lead_id ? Directory.name(team.lead_id) : '',
      csuite: team && team.csuite_id ? Directory.name(team.csuite_id) : '', manager: e.manager_id ? Directory.name(e.manager_id) : '',
      join_date: e.join_date, end_date: e.end_date, balances: BalanceService.summary(e.emp_id, year),
      days_taken: 0, lop_days: 0, pending: pendingOf(e.emp_id), requests: 0,
    };
  }

  // ------------------------------------------------------------------ helpers

  function managerFor(role, team) {
    if (!team) return '';
    if (role === 'EMPLOYEE') return team.lead_id || team.csuite_id || '';
    if (role === 'LEAD') return team.csuite_id || '';
    return '';
  }

  function monthsBetween(start, end) {
    if (!start || !end) return '';
    const days = (DateUtil.parse(end) - DateUtil.parse(start)) / 86400000 + 1;
    return Math.max(1, Math.round(days / 30.44));
  }

  function changes(before, after, fields) {
    return fields.filter((f) => String(before[f] === undefined ? '' : before[f]) !== String(after[f] === undefined ? '' : after[f]))
      .map((f) => f + ': ' + (before[f] || '—') + ' → ' + (after[f] || '—')).join('; ');
  }

  /** Re-points every active member of a team at the team's current lead / C-suite. */
  function relinkTeam(team) {
    const employees = Db.table('Employees');
    employees.where((e) => e.team_id === team.team_id && e.status === 'Active').forEach((e) => {
      const manager = e.emp_id === team.lead_id ? (team.csuite_id || '') : managerFor(e.role_level, team);
      if (manager !== e.manager_id && manager !== e.emp_id) employees.update(e.emp_id, { manager_id: manager, updated_at: DateUtil.now() });
    });
  }

  /**
   * After a person changes team/role/status, teams that still name them as lead or
   * approver but no longer should are cleared (and their members re-pointed).
   */
  function releaseStaleLinks(admin, person) {
    const teams = Db.table('Teams');
    teams.all().forEach((t) => {
      const patch = {};
      const active = person.status === 'Active';
      if (t.lead_id === person.emp_id && (!active || person.role_level !== 'LEAD' || person.team_id !== t.team_id)) patch.lead_id = '';
      if (t.csuite_id === person.emp_id && (!active || person.role_level !== 'CSUITE')) patch.csuite_id = '';
      if (!Object.keys(patch).length) return;
      const updated = teams.update(t.team_id, patch);
      Audit.log({ actor: admin.email, action: 'UPDATE', entity: 'Teams', entity_id: t.team_id,
        new_value: Object.keys(patch).join(', ') + ' cleared', reason: person.name + ' no longer holds that role' });
      relinkTeam(updated);
    });
  }

  // ------------------------------------------------------------------ people

  /**
   * @param {{emp_id?, name, email, role_level, emp_type, team_id, join_date, end_date?, status?}} input
   * @returns {{person: object, created: boolean, balances: string[]}}
   */
  function savePerson(admin, input) {
    const employees = Db.table('Employees');
    const i = input || {};
    const v = {
      emp_id: clean(i.emp_id), name: clean(i.name), email: clean(i.email).toLowerCase(),
      role_level: clean(i.role_level) || 'EMPLOYEE', emp_type: clean(i.emp_type) || 'FT',
      team_id: clean(i.team_id), join_date: clean(i.join_date), end_date: clean(i.end_date),
      status: clean(i.status) || 'Active',
    };
    if (!v.name) throw Errors.invalid('Enter a name.');
    if (!EMAIL.test(v.email)) throw Errors.invalid('Enter a valid email address.');
    if (ENUMS.ROLE_LEVEL.indexOf(v.role_level) === -1) throw Errors.invalid('Choose a role.');
    if (ENUMS.EMP_TYPE.indexOf(v.emp_type) === -1) throw Errors.invalid('Choose full-time, intern or contractor.');
    if (ENUMS.EMP_STATUS.indexOf(v.status) === -1) throw Errors.invalid('Choose Active or Inactive.');
    if (!v.join_date || !DATE_OK(v.join_date)) throw Errors.invalid('Enter the joining date.');
    if (!DATE_OK(v.end_date) || (v.end_date && v.end_date < v.join_date)) throw Errors.invalid('The end date must be after the joining date.');
    if (v.emp_type !== 'FT' && !v.end_date) throw Errors.invalid('Interns and contractors need a contract end date.');
    const team = Directory.team(v.team_id);
    if (!team) throw Errors.invalid('Choose a team.');
    const clash = employees.find((e) => e.email.toLowerCase() === v.email && e.emp_id !== v.emp_id);
    if (clash) throw Errors.conflict(v.email + ' already belongs to ' + clash.name + ' (' + clash.emp_id + ').');

    const now = DateUtil.now();
    const record = Object.assign({}, v, {
      manager_id: managerFor(v.role_level, team), policy_id: POLICY_FOR[v.emp_type],
      contract_months: v.emp_type === 'FT' ? '' : monthsBetween(v.join_date, v.end_date), updated_at: now,
    });
    const existing = v.emp_id ? employees.get(v.emp_id) : null;
    if (v.emp_id && !existing) throw Errors.notFound('Employee ' + v.emp_id);
    let saved;
    if (existing) {
      if (team.lead_id === existing.emp_id) record.manager_id = team.csuite_id || '';   // the lead reports to the C-suite
      saved = employees.update(v.emp_id, record);
      const diff = changes(existing, saved, ['name', 'email', 'role_level', 'emp_type', 'team_id', 'join_date', 'end_date', 'status']);
      if (diff) {
        Audit.log({ actor: admin.email, action: v.status === 'Inactive' && existing.status !== 'Inactive' ? 'DEACTIVATE' : 'UPDATE',
          entity: 'Employees', entity_id: v.emp_id, new_value: diff, reason: 'Admin edit' });
      }
    } else {
      record.emp_id = employees.nextId('E', 3);
      record.slack_user_id = '';
      record.created_at = now;
      saved = employees.insert(record);
      Audit.log({ actor: admin.email, action: 'CREATE', entity: 'Employees', entity_id: saved.emp_id,
        new_value: saved.name + ' · ' + saved.email + ' · ' + saved.role_level + ' · ' + saved.team_id, reason: 'Admin added person' });
    }

    releaseStaleLinks(admin, saved);
    // A new team lead fills an empty lead slot, so their team's approvals work right away.
    const teams = Db.table('Teams');
    if (saved.status === 'Active' && saved.role_level === 'LEAD' && !team.lead_id) {
      teams.update(team.team_id, { lead_id: saved.emp_id });
      relinkTeam(teams.get(team.team_id));
    }
    const balances = saved.status === 'Active' ? BalanceService.ensureYear(saved) : [];
    return { person: Directory.profile(employees.get(saved.emp_id)), created: !existing, balances: balances };
  }

  // ------------------------------------------------------------------ teams

  /** @param {{team_id?, team_name, lead_id?, csuite_id?, active?}} input */
  function saveTeam(admin, input) {
    const teams = Db.table('Teams');
    const employees = Db.table('Employees');
    const i = input || {};
    const v = {
      team_id: clean(i.team_id), team_name: clean(i.team_name),
      lead_id: clean(i.lead_id), csuite_id: clean(i.csuite_id), active: i.active !== false,
    };
    if (!v.team_name) throw Errors.invalid('Enter a team name.');
    const dupName = teams.find((t) => t.team_name.toLowerCase() === v.team_name.toLowerCase() && t.team_id !== v.team_id);
    if (dupName) throw Errors.conflict('A team called ' + v.team_name + ' already exists.');
    const lead = v.lead_id ? employees.get(v.lead_id) : null;
    const csuite = v.csuite_id ? employees.get(v.csuite_id) : null;
    if (v.lead_id && !lead) throw Errors.invalid('Choose the team lead from the list.');
    if (lead && lead.role_level === 'CSUITE') throw Errors.invalid('A C-suite person can\'t be a team lead. Choose them as the approver instead.');
    if (v.csuite_id && (!csuite || csuite.role_level !== 'CSUITE')) throw Errors.invalid('The approver must be a C-suite person.');

    const now = DateUtil.now();
    const existing = v.team_id ? teams.get(v.team_id) : null;
    if (v.team_id && !existing) throw Errors.notFound('Team ' + v.team_id);
    let saved;
    if (existing) {
      saved = teams.update(v.team_id, v);
      const diff = changes(existing, saved, ['team_name', 'lead_id', 'csuite_id', 'active']);
      if (diff) Audit.log({ actor: admin.email, action: 'UPDATE', entity: 'Teams', entity_id: v.team_id, new_value: diff, reason: 'Admin edit' });
    } else {
      const base = 'T-' + (v.team_name.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'TEAM');
      let id = base;
      for (let k = 2; teams.get(id); k++) id = base + k;
      saved = teams.insert(Object.assign({}, v, { team_id: id, slack_channel: Config.get('SLACK_DEFAULT_CHANNEL', '#leave-requests'), created_at: now }));
      Audit.log({ actor: admin.email, action: 'CREATE', entity: 'Teams', entity_id: id, new_value: v.team_name, reason: 'Admin added team' });
    }

    // The chosen lead moves into this team with the LEAD role (and leaves any old lead slot).
    if (lead && (lead.team_id !== saved.team_id || lead.role_level !== 'LEAD')) {
      const moved = employees.update(lead.emp_id, { team_id: saved.team_id, role_level: 'LEAD', updated_at: now });
      Audit.log({ actor: admin.email, action: 'UPDATE', entity: 'Employees', entity_id: lead.emp_id,
        new_value: 'team ' + saved.team_id + ', role LEAD', reason: 'Made team lead of ' + saved.team_name });
      releaseStaleLinks(admin, moved);
    }
    // A previous lead of this team who was replaced goes back to EMPLOYEE in the same team.
    if (existing && existing.lead_id && existing.lead_id !== v.lead_id) {
      const old = employees.get(existing.lead_id);
      if (old && old.role_level === 'LEAD' && old.team_id === saved.team_id) {
        employees.update(old.emp_id, { role_level: 'EMPLOYEE', updated_at: now });
        Audit.log({ actor: admin.email, action: 'UPDATE', entity: 'Employees', entity_id: old.emp_id,
          new_value: 'role EMPLOYEE', reason: 'Replaced as lead of ' + saved.team_name });
      }
    }
    relinkTeam(teams.get(saved.team_id));
    return teams.get(saved.team_id);
  }

  // ------------------------------------------------------------------ leave

  function adjustBalance(admin, empId, typeId, days, reason) {
    const delta = Number(days);
    const why = clean(reason);
    if (!Directory.employee(empId)) throw Errors.notFound('Employee ' + empId);
    if (!Catalog.leaveType(typeId)) throw Errors.invalid('Choose a leave type.');
    if (!delta || isNaN(delta) || Math.round(delta * 2) !== delta * 2) throw Errors.invalid('Enter days in steps of 0.5, e.g. 1, -2 or 0.5.');
    if (!why) throw Errors.invalid('Add a reason, e.g. "Comp-off for weekend work".');
    const year = DateUtil.year(DateUtil.today());
    const before = BalanceService.summary(empId, year).find((b) => b.type_id === typeId) || { available: 0 };
    const row = BalanceService.adjust(empId, typeId, year, delta);
    Audit.log({ actor: admin.email, action: 'ADJUST', entity: 'LeaveBalances', entity_id: row.bal_id, field: 'adjusted',
      old_value: before.available + ' available', new_value: row.available + ' available (' + (delta > 0 ? '+' : '') + delta + ')', reason: why });
    return BalanceService.summary(empId, year);
  }

  function saveQuota(admin, ruleId, yearlyQuota) {
    const quota = Number(yearlyQuota);
    if (yearlyQuota === '' || isNaN(quota) || quota < 0 || quota > 366) throw Errors.invalid('Enter a yearly quota between 0 and 366 days.');
    const policies = Db.table('Policies');
    const rule = policies.get(ruleId);
    if (!rule) throw Errors.notFound('Policy rule ' + ruleId);
    const saved = policies.update(ruleId, { yearly_quota: quota });
    Audit.log({ actor: admin.email, action: 'UPDATE', entity: 'Policies', entity_id: ruleId, field: 'yearly_quota',
      old_value: rule.yearly_quota, new_value: quota, reason: 'Admin changed quota (' + rule.policy_name + ' ' + rule.type_id + ')' });
    return saved;
  }

  return { overview, savePerson, saveTeam, adjustBalance, saveQuota };
})();
