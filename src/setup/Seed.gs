/**
 * Seed.gs — dummy data for testing.
 * Pure JavaScript (no sheet calls). Balances are COMPUTED from the sample
 * requests and the quarterly accrual rule, so every tab agrees with the others.
 */
function buildSeed_(nowStr) {
  const Y = LD_CONFIG.SEED_YEAR;

  const settings = [
    ['ORG_NAME', LD_CONFIG.ORG_NAME, 'Organisation name shown in the app.'],
    ['APP_NAME', LD_CONFIG.APP_NAME, 'App name shown in the app and Slack.'],
    ['ADMIN_EMAILS', 'shivakumar.u@darukaa.com', 'Comma-separated emails that can open the Admin page.'],
    ['TIMEZONE', LD_CONFIG.TIMEZONE, 'Time zone for dates and the accrual job.'],
    ['LEAVE_YEAR_START_MONTH', '1', '1 = January–December. Unused leave expires at the end of the leave year.'],
    ['CARRY_FORWARD', 'FALSE', 'No carry-forward into the next year. Carries across quarters within the year.'],
    ['ROUNDING', '0.5', 'Prorated credits are rounded to the nearest this many days.'],
    ['WEEKEND_DAYS', 'SAT,SUN', 'Days never counted as leave.'],
    ['HALF_DAY_ALLOWED', 'TRUE', 'Allow half-day requests (0.5 day).'],
    ['APPROVE_RULE', 'ANY_ONE', 'ANY_ONE = first approval approves the request.'],
    ['REJECT_RULE', 'ANY_ONE', 'ANY_ONE = any rejection rejects, even after an approval.'],
    ['DECISION_LOCK', 'LEAVE_START', 'Decisions can change until the leave start date, then lock.'],
    ['OVER_QUOTA', 'ALLOW_AS_LOP', 'Allow requests beyond balance; extra days recorded as Loss of Pay.'],
    ['CSUITE_AUTO_APPROVE', 'TRUE', 'C-suite leave is approved automatically and logged.'],
    ['SLACK_ENABLED', 'FALSE', 'Turn on after adding the webhook URL in Script Properties (SLACK_WEBHOOK_URL).'],
    ['SLACK_DEFAULT_CHANNEL', '#leave-requests', 'Channel for request messages when a team has none.'],
    ['SLACK_ADMIN_CHANNEL', '#hr-admin', 'Channel for accrual and admin summaries.'],
    ['EMAIL_FALLBACK', 'TRUE', 'Also email approvers if Slack is off or fails.'],
    ['APP_URL', '', 'Web app URL. Fill in after deploying (used for "Open request" buttons).'],
    ['TEST_MODE', 'TRUE', 'Admins can "View as" any employee to test the app. Set FALSE before go-live.'],
    ['DB_VERSION', String(LD_CONFIG.DB_VERSION), 'Schema version. Do not edit.'],
  ].map(function (r) { return { key: r[0], value: r[1], description: r[2] }; });

  const teams = [
    ['T-CXO', 'C-Suite', '', '', '#leave-requests'],
    ['T-BD', 'BD Team', 'E003', 'E001', '#leave-requests'],
    ['T-PRD', 'Product', 'E004', 'E002', '#leave-requests'],
    ['T-SCI', 'Science', 'E005', 'E002', '#leave-requests'],
    [LD_CONFIG.TEST_TEAM.team_id, LD_CONFIG.TEST_TEAM.team_name, testLead_(), testCxo_(), '#leave-requests'],
  ].map(function (r) {
    return { team_id: r[0], team_name: r[1], lead_id: r[2], csuite_id: r[3], slack_channel: r[4], active: true, created_at: nowStr };
  });

  // [id, name, emailLocal, role, type, team, manager, join, end, months]
  const people = [
    ['E001', 'Vikram',   'vikram',   'CSUITE',   'FT',  'T-CXO', '',     '2022-04-01', '', ''],
    ['E002', 'Guneet',   'guneet',   'CSUITE',   'FT',  'T-CXO', '',     '2022-04-01', '', ''],
    ['E003', 'Ankita',   'ankita',   'LEAD',     'FT',  'T-BD',  'E001', '2023-01-09', '', ''],
    ['E004', 'Jaya',     'jaya',     'LEAD',     'FT',  'T-PRD', 'E002', '2023-03-01', '', ''],
    ['E005', 'Gaurav',   'gaurav',   'LEAD',     'FT',  'T-SCI', 'E002', '2023-06-12', '', ''],
    ['E006', 'Arshad',   'arshad',   'EMPLOYEE', 'FT',  'T-BD',  'E003', '2024-07-01', '', ''],
    ['E007', 'Aman',     'aman',     'EMPLOYEE', 'INT', 'T-BD',  'E003', '2026-08-01', '2027-01-31', 6],
    ['E008', 'Atharv',   'atharv',   'EMPLOYEE', 'INT', 'T-BD',  'E003', '2026-10-01', '2026-12-31', 3],
    ['E009', 'Sayan',    'sayan',    'EMPLOYEE', 'FT',  'T-BD',  'E003', '2025-02-03', '', ''],
    ['E010', 'Tanu',     'tanu',     'EMPLOYEE', 'FT',  'T-BD',  'E003', '2025-05-19', '', ''],
    ['E011', 'Shiva',    'shiva',    'EMPLOYEE', 'INT', 'T-PRD', 'E004', '2026-07-01', '2026-12-31', 6],
    ['E012', 'Hardik',   'hardik',   'EMPLOYEE', 'INT', 'T-PRD', 'E004', '2026-09-01', '2027-02-28', 6],
    ['E013', 'Utkarsh',  'utkarsh',  'EMPLOYEE', 'FT',  'T-PRD', 'E004', '2024-11-04', '', ''],
    ['E014', 'Varun C',  'varunc',   'EMPLOYEE', 'INT', 'T-PRD', 'E004', '2026-10-01', '2026-12-31', 3],
    ['E015', 'Harsh',    'harsh',    'EMPLOYEE', 'FT',  'T-PRD', 'E004', '2025-08-11', '', ''],
    ['E016', 'Soudipta', 'soudipta', 'EMPLOYEE', 'FT',  'T-SCI', 'E005', '2024-03-18', '', ''],
    ['E017', 'Varun S',  'varuns',   'EMPLOYEE', 'INT', 'T-SCI', 'E005', '2026-06-01', '2026-11-30', 6],
    ['E018', 'Priyanka', 'priyanka', 'EMPLOYEE', 'INT', 'T-SCI', 'E005', '2026-11-01', '2027-01-31', 3],
  ];
  const policyFor = { FT: 'P-FT', INT: 'P-INT', CON: 'P-CON' };
  testPeople_().forEach((t) => people.push([t.emp_id, t.name, '', t.role_level, 'FT', t.team_id, t.manager_id, t.join_date, '', '']));
  const testEmail = {};
  LD_CONFIG.TEST_ACCOUNTS.forEach((t) => { testEmail[t.emp_id] = t.email; });
  const employees = people.map(function (p) {
    return {
      emp_id: p[0], name: p[1], email: testEmail[p[0]] || (p[2] + '@darukaa.com'), role_level: p[3], emp_type: p[4],
      team_id: p[5], manager_id: p[6], policy_id: policyFor[p[4]], join_date: p[7], end_date: p[8],
      contract_months: p[9], slack_user_id: '', status: 'Active', created_at: nowStr, updated_at: nowStr,
    };
  });

  const leaveTypes = [
    { type_id: 'LT-PL', name: 'Paid / Casual Leave', code: 'PL', is_paid: true, half_day_allowed: true, color: '#2D7A4C', sort_order: 1, active: true },
    { type_id: 'LT-SL', name: 'Sick Leave', code: 'SL', is_paid: true, half_day_allowed: true, color: '#355D8C', sort_order: 2, active: true },
  ];

  const policies = [];
  [['P-FT', 'Full-time', 'FT'], ['P-INT', 'Intern', 'INT'], ['P-CON', 'Contractor', 'CON']].forEach(function (p) {
    [['LT-PL', 20], ['LT-SL', 12]].forEach(function (q) {
      policies.push({
        rule_id: 'PR-' + ('0' + (policies.length + 1)).slice(-2), policy_id: p[0], policy_name: p[1], applies_to: p[2],
        type_id: q[0], yearly_quota: q[1], accrual: 'QUARTERLY', carry_forward: false, active: true,
      });
    });
  });
  const quota = {};   // quota['P-FT']['LT-PL'] = 20
  policies.forEach(function (r) { (quota[r.policy_id] = quota[r.policy_id] || {})[r.type_id] = r.yearly_quota; });

  const approvalFlow = [
    ['F1', 'EMPLOYEE', 'TEAM_LEAD'],
    ['F2', 'EMPLOYEE', 'TEAM_CSUITE'],
    ['F3', 'LEAD', 'TEAM_CSUITE'],
    ['F4', 'CSUITE', 'AUTO'],
  ].map(function (r) {
    return { flow_id: r[0], requester_role: r[1], team_id: '*', approver_rule: r[2], approver_id: '', mode: 'PARALLEL', active: true };
  });

  // Sample list for the seed — admin should replace with the official calendar.
  const holidays = [
    ['2026-01-26', 'Republic Day'], ['2026-03-04', 'Holi'], ['2026-08-15', 'Independence Day'],
    ['2026-10-02', 'Gandhi Jayanti'], ['2026-10-20', 'Dussehra'], ['2026-11-08', 'Diwali'], ['2026-12-25', 'Christmas'],
  ].map(function (h, i) {
    return { holiday_id: 'H-' + Y + '-' + ('0' + (i + 1)).slice(-2), date: h[0], name: h[1], optional: false, year: Y };
  });
  const holidaySet = {};
  holidays.forEach(function (h) { holidaySet[h.date] = true; });

  // ---- Accrual (quarterly, prorated by months active in the quarter) ----
  const lastQuarter = 4;   // seed as of Nov 2026: Q1–Q4 credited
  const balances = {};     // key emp|type → balance object
  const empById = {};
  employees.forEach(function (e) { empById[e.emp_id] = e; });

  employees.forEach(function (e) {
    leaveTypes.forEach(function (lt) {
      const yearly = quota[e.policy_id][lt.type_id];
      let accrued = 0;
      for (let q = 1; q <= lastQuarter; q++) {
        const m = DateUtil.monthsActiveInQuarter(e.join_date, e.end_date, Y, q);
        accrued += roundTo_(yearly * m / 12, 0.5);
      }
      balances[e.emp_id + '|' + lt.type_id] = {
        emp_id: e.emp_id, year: Y, type_id: lt.type_id, accrued: accrued, adjusted: 0,
        used: 0, pending: 0, available: 0, last_accrual: Y + '-Q' + lastQuarter, updated_at: nowStr,
      };
    });
  });
  // One manual adjustment, mirrored in AuditLog.
  balances['E016|LT-SL'].adjusted = 1;

  // ---- Requests ----
  // [emp, type, start, end, halfDay, reason, status, submittedAt, decisions[[approver, decision, at, comment]], cancelledAt]
  const R = [
    ['E013', 'LT-PL', '2026-03-16', '2026-03-20', false, 'Trip home to Lucknow', 'APPROVED', '2026-03-02 09:40',
      [['E004', 'APPROVED', '2026-03-02 11:15', 'Approved'], ['E002', 'NO_ACTION', '', '']]],
    ['E002', 'LT-PL', '2026-04-13', '2026-04-14', false, 'Personal', 'APPROVED', '2026-04-01 18:05',
      [['SYSTEM', 'AUTO', '2026-04-01 18:05', 'C-suite auto-approval']]],
    ['E006', 'LT-PL', '2026-05-04', '2026-05-08', false, 'Family wedding', 'APPROVED', '2026-04-20 10:02',
      [['E003', 'APPROVED', '2026-04-20 12:30', ''], ['E001', 'APPROVED', '2026-04-21 09:10', 'Enjoy']]],
    ['E013', 'LT-SL', '2026-06-08', '2026-06-09', false, 'Fever', 'APPROVED', '2026-06-08 08:15',
      [['E004', 'APPROVED', '2026-06-08 13:40', 'Get well soon'], ['E002', 'APPROVED', '2026-06-08 09:05', '']]],
    ['E003', 'LT-PL', '2026-07-06', '2026-07-10', false, 'Vacation', 'APPROVED', '2026-06-22 16:20',
      [['E001', 'APPROVED', '2026-06-23 10:00', '']]],
    ['E017', 'LT-SL', '2026-07-14', '2026-07-14', true, 'Doctor appointment', 'APPROVED', '2026-07-13 19:30',
      [['E005', 'APPROVED', '2026-07-14 08:50', ''], ['E002', 'NO_ACTION', '', '']]],
    ['E009', 'LT-PL', '2026-08-17', '2026-08-21', false, 'Short holiday', 'REJECTED', '2026-08-03 11:00',
      [['E003', 'APPROVED', '2026-08-03 12:10', 'OK from my side'], ['E001', 'REJECTED', '2026-08-04 09:30', 'Client visit that week, please move it by a week']]],
    ['E006', 'LT-PL', '2026-09-07', '2026-09-18', false, 'Travel abroad', 'APPROVED', '2026-08-24 10:00',
      [['E003', 'APPROVED', '2026-08-24 15:00', ''], ['E001', 'APPROVED', '2026-08-25 10:30', '']]],
    ['E012', 'LT-PL', '2026-10-09', '2026-10-09', false, 'Personal work', 'APPROVED', '2026-10-06 17:45',
      [['E004', 'APPROVED', '2026-10-07 10:05', ''], ['E002', 'NO_ACTION', '', '']]],
    ['E006', 'LT-PL', '2026-10-12', '2026-10-15', false, 'Moving house', 'APPROVED', '2026-10-05 09:20',
      [['E003', 'NO_ACTION', '', ''], ['E001', 'APPROVED', '2026-10-05 11:00', '']]],
    ['E011', 'LT-PL', '2026-11-06', '2026-11-06', false, 'College exam', 'CANCELLED', '2026-11-02 10:30',
      [['E004', 'NO_ACTION', '', ''], ['E002', 'NO_ACTION', '', '']], '2026-11-02 18:00'],
    ['E012', 'LT-PL', '2026-11-12', '2026-11-13', false, 'Family function in Pune', 'PENDING', '2026-11-03 10:14',
      [['E004', 'PENDING', '', ''], ['E002', 'PENDING', '', '']]],
    ['E006', 'LT-PL', '2026-11-23', '2026-11-25', false, 'Visiting parents', 'PENDING', '2026-11-03 16:45',
      [['E003', 'PENDING', '', ''], ['E001', 'PENDING', '', '']]],
  ];

  const requests = [];
  const approvals = [];
  R.forEach(function (r, i) {
    const days = DateUtil.workingDays(r[2], r[3], { halfDay: r[4], holidays: holidaySet, weekend: [0, 6] });
    const bal = balances[r[0] + '|' + r[1]];
    const avail = bal.accrued + bal.adjusted - bal.used - bal.pending;   // at submission time
    const paid = Math.max(0, Math.min(days, avail));
    const lop = days - paid;
    const status = r[6];
    if (status === 'APPROVED') bal.used += paid;
    if (status === 'PENDING') bal.pending += paid;

    // final_by = the decision that set the outcome
    let finalBy = '', finalAt = '';
    const decided = r[8].filter(function (d) { return d[2]; }).sort(function (a, b) { return a[2] < b[2] ? -1 : 1; });
    if (status === 'APPROVED') {
      const first = decided.filter(function (d) { return d[1] === 'APPROVED' || d[1] === 'AUTO'; })[0];
      finalBy = first[0]; finalAt = first[2];
    } else if (status === 'REJECTED') {
      const rej = decided.filter(function (d) { return d[1] === 'REJECTED'; })[0];
      finalBy = rej[0]; finalAt = rej[2];
    } else if (status === 'CANCELLED') {
      finalBy = r[0]; finalAt = r[9];
    }

    const reqId = 'LR-' + Y + '-' + ('000' + (i + 1)).slice(-4);
    requests.push({
      req_id: reqId, emp_id: r[0], type_id: r[1], start_date: r[2], end_date: r[3], half_day: r[4],
      days: days, paid_days: paid, lop_days: lop, over_quota: lop > 0, reason: r[5], status: status,
      final_by: finalBy, final_at: finalAt, submitted_at: r[7], cancelled_at: r[9] || '',
      updated_at: finalAt || r[7],
    });
    r[8].forEach(function (d) {
      approvals.push({
        appr_id: 'A' + ('000' + (approvals.length + 1)).slice(-4), req_id: reqId, approver_id: d[0],
        approver_role: d[0] === 'SYSTEM' ? 'SYSTEM' : (empById[d[0]].role_level === 'CSUITE' ? 'CSUITE' : 'TEAM_LEAD'),
        decision: d[1], comment: d[3], notified_at: r[7], decided_at: d[2],
      });
    });
  });

  const balanceRows = Object.keys(balances).map(function (k, i) {
    const b = balances[k];
    b.available = b.accrued + b.adjusted - b.used - b.pending;
    return Object.assign({ bal_id: 'B' + ('000' + (i + 1)).slice(-4) }, b);
  });

  const audit = [
    ['2026-01-01 00:05', 'system', 'ACCRUE', 'LeaveBalances', 'ALL', '', '', '', Y + '-Q1 quarterly accrual'],
    ['2026-04-01 00:05', 'system', 'ACCRUE', 'LeaveBalances', 'ALL', '', '', '', Y + '-Q2 quarterly accrual'],
    ['2026-07-01 00:05', 'system', 'ACCRUE', 'LeaveBalances', 'ALL', '', '', '', Y + '-Q3 quarterly accrual'],
    ['2026-08-04 09:30', 'vikram@darukaa.com', 'REJECT', 'LeaveRequests', 'LR-2026-0007', 'status', 'APPROVED', 'REJECTED', 'Vikram rejected after Ankita approved'],
    ['2026-10-01 00:05', 'system', 'ACCRUE', 'LeaveBalances', 'ALL', '', '', '', Y + '-Q4 quarterly accrual'],
    ['2026-10-14 16:40', 'shivakumar.u@darukaa.com', 'ADJUST', 'LeaveBalances', 'E016|LT-SL', 'adjusted', '0', '1', 'Comp-off for field survey weekend'],
  ].map(function (a, i) {
    return { log_id: 'L' + ('000000' + (i + 1)).slice(-6), timestamp: a[0], actor: a[1], action: a[2], entity: a[3],
      entity_id: a[4], field: a[5], old_value: a[6], new_value: a[7], reason: a[8] };
  });

  return {
    Settings: settings, Employees: employees, Teams: teams, LeaveTypes: leaveTypes, Policies: policies,
    ApprovalFlow: approvalFlow, Holidays: holidays, LeaveBalances: balanceRows, LeaveRequests: requests,
    Approvals: approvals, AuditLog: audit,
  };
}


/** Rounds to the nearest step, e.g. roundTo_(3.33, 0.5) → 3.5. */
function roundTo_(value, step) {
  return Math.round(value / step) * step;
}

/** The three test accounts as Employees rows (team, manager, join date filled in). */
function testPeople_() {
  const team = LD_CONFIG.TEST_TEAM.team_id;
  const managerOf = { CSUITE: '', LEAD: testCxo_(), EMPLOYEE: testLead_() };
  return LD_CONFIG.TEST_ACCOUNTS.map((t) => Object.assign({}, t, {
    team_id: team, manager_id: managerOf[t.role_level], join_date: LD_CONFIG.SEED_YEAR + '-01-01',
  }));
}

const testCxo_ = () => LD_CONFIG.TEST_ACCOUNTS.find((t) => t.role_level === 'CSUITE').emp_id;
const testLead_ = () => LD_CONFIG.TEST_ACCOUNTS.find((t) => t.role_level === 'LEAD').emp_id;
