/**
 * Schema.gs — the database contract.
 * Every table (sheet tab), its columns and their types live here and nowhere else.
 * Setup.gs builds the sheets from it; the Repository reads/writes rows with it.
 * Add a column = add one line here, then run setupDatabase().
 */

/* ----------------------------------------------------------------------------
 * 1. CONFIG
 * ------------------------------------------------------------------------- */
const LD_CONFIG = {
  SPREADSHEET_TITLE: 'Darukaa Leave Desk – Database',
  APP_NAME: 'Leave Desk',
  ORG_NAME: 'Darukaa.Earth',
  TIMEZONE: 'Asia/Kolkata',
  DB_VERSION: 1,
  SEED_YEAR: 2026,
  VALIDATION_ROWS: 1000,          // dropdowns/formats applied to this many rows
  HEADER_BG: '#1D6B57',
  HEADER_FG: '#FFFFFF',
  PROTECT_TAG: 'LeaveDesk: managed by the app',

  // Test accounts: a separate "Test Team" so the dummy org data stays untouched.
  //   Test Employee → Test Lead + Test CXO (in parallel); Test Lead → Test CXO; Test CXO → auto.
  // Created by the seed and by setupTestTeam(). Remove before go-live.
  TEST_TEAM: { team_id: 'T-TEST', team_name: 'Test Team' },
  TEST_ACCOUNTS: [
    { emp_id: 'E901', name: 'Test CXO',      role_level: 'CSUITE',   email: 'shivakumarullagaddi855@gmail.com' },
    { emp_id: 'E902', name: 'Test Lead',     role_level: 'LEAD',     email: 'shivakumarullagaddi56@gmail.com' },
    { emp_id: 'E903', name: 'Test Employee', role_level: 'EMPLOYEE', email: 'shivakumar.u@darukaa.com' },
  ],
};

const ENUMS = {
  ROLE_LEVEL:     ['CSUITE', 'LEAD', 'EMPLOYEE'],
  EMP_TYPE:       ['FT', 'INT', 'CON'],                 // full-time, intern, contractor
  EMP_STATUS:     ['Active', 'Inactive'],
  ACCRUAL:        ['QUARTERLY', 'MONTHLY', 'YEARLY'],
  REQUESTER_ROLE: ['EMPLOYEE', 'LEAD', 'CSUITE'],
  APPROVER_RULE:  ['TEAM_LEAD', 'TEAM_CSUITE', 'SPECIFIC', 'AUTO'],
  FLOW_MODE:      ['PARALLEL'],
  REQ_STATUS:     ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVER_ROLE:  ['TEAM_LEAD', 'CSUITE', 'SPECIFIC', 'SYSTEM'],
  DECISION:       ['PENDING', 'APPROVED', 'REJECTED', 'NO_ACTION', 'AUTO'],
  AUDIT_ACTION:   ['SETUP', 'CREATE', 'UPDATE', 'DEACTIVATE', 'SUBMIT', 'APPROVE',
                   'REJECT', 'CANCEL', 'AUTO_APPROVE', 'ACCRUE', 'ADJUST', 'EXPIRE', 'LOCK'],
};

/* ----------------------------------------------------------------------------
 * 2. SCHEMA  (one entry per tab, columns in display order)
 *    type: id | text | email | date | datetime | number | bool | enum | ref
 * ------------------------------------------------------------------------- */
function col_(name, type, note, extra) {
  return Object.assign({ name: name, type: type, note: note || '' }, extra || {});
}

const DB_SCHEMA = [
  {
    name: 'Settings', group: 'config', editedBy: 'Admin page',
    purpose: 'App-wide switches and values (key → value).',
    columns: [
      col_('key', 'id', 'Setting name. Code looks settings up by this key. Do not rename.'),
      col_('value', 'text', 'Setting value. Lists are comma-separated.'),
      col_('description', 'text', 'What this setting controls.'),
    ],
  },
  {
    name: 'Employees', group: 'master', editedBy: 'Admin page',
    purpose: 'Everyone in the org: C-suite, team leads, employees, interns, contractors.',
    columns: [
      col_('emp_id', 'id', 'Unique ID, e.g. E001. Never reuse an ID.'),
      col_('name', 'text', 'Display name.'),
      col_('email', 'email', 'Google Workspace email. The app identifies people by this.'),
      col_('role_level', 'enum', 'CSUITE, LEAD or EMPLOYEE. Decides the approval route.', { values: ENUMS.ROLE_LEVEL }),
      col_('emp_type', 'enum', 'FT = full-time, INT = intern, CON = contractor.', { values: ENUMS.EMP_TYPE }),
      col_('team_id', 'ref', 'Team this person belongs to (Teams.team_id).', { ref: 'Teams.team_id' }),
      col_('manager_id', 'ref', 'Direct reporting manager (Employees.emp_id). Blank for C-suite.', { ref: 'Employees.emp_id' }),
      col_('policy_id', 'ref', 'Leave policy (Policies.policy_id).', { ref: 'Policies.policy_id' }),
      col_('join_date', 'date', 'First working day.'),
      col_('end_date', 'date', 'Contract end (interns/contractors). Blank = ongoing. Extending this tops up leave.'),
      col_('contract_months', 'number', 'Contract length in months. Blank for ongoing full-time.'),
      col_('slack_user_id', 'id', 'Slack member ID (e.g. U04ABC123) for @mentions. Optional.'),
      col_('status', 'enum', 'Active or Inactive. Deactivate instead of deleting.', { values: ENUMS.EMP_STATUS }),
      col_('created_at', 'datetime', 'Row created.'),
      col_('updated_at', 'datetime', 'Row last changed.'),
    ],
  },
  {
    name: 'Teams', group: 'master', editedBy: 'Admin page',
    purpose: 'Teams, their lead, and the C-suite member who approves for them.',
    columns: [
      col_('team_id', 'id', 'Unique ID, e.g. T-BD.'),
      col_('team_name', 'text', 'Display name.'),
      col_('lead_id', 'ref', 'Team lead (Employees.emp_id). Approves employee leave.', { ref: 'Employees.emp_id' }),
      col_('csuite_id', 'ref', 'C-suite approver (Employees.emp_id). Approves employee AND lead leave.', { ref: 'Employees.emp_id' }),
      col_('slack_channel', 'text', 'Channel for this team\'s leave messages.'),
      col_('active', 'bool', 'Untick to retire a team.'),
      col_('created_at', 'datetime', 'Row created.'),
    ],
  },
  {
    name: 'LeaveTypes', group: 'config', editedBy: 'Admin page',
    purpose: 'Kinds of leave people can apply for.',
    columns: [
      col_('type_id', 'id', 'Unique ID, e.g. LT-PL.'),
      col_('name', 'text', 'Shown in the app.'),
      col_('code', 'id', 'Short code used in reports.'),
      col_('is_paid', 'bool', 'Paid leave type.'),
      col_('half_day_allowed', 'bool', 'Allow half-day requests.'),
      col_('color', 'text', 'Hex colour used in the app.'),
      col_('sort_order', 'number', 'Order in dropdowns.'),
      col_('active', 'bool', 'Untick to hide from the app.'),
    ],
  },
  {
    name: 'Policies', group: 'config', editedBy: 'Admin page',
    purpose: 'Yearly quota per leave type for each employee category.',
    columns: [
      col_('rule_id', 'id', 'Unique row ID, e.g. PR-01.'),
      col_('policy_id', 'id', 'Policy this rule belongs to (one policy has one row per leave type).'),
      col_('policy_name', 'text', 'Display name.'),
      col_('applies_to', 'enum', 'Employee type this policy is for.', { values: ENUMS.EMP_TYPE }),
      col_('type_id', 'ref', 'Leave type (LeaveTypes.type_id).', { ref: 'LeaveTypes.type_id' }),
      col_('yearly_quota', 'number', 'Days per full year. Shorter stays are prorated: quota × months ÷ 12.'),
      col_('accrual', 'enum', 'How often leave is credited.', { values: ENUMS.ACCRUAL }),
      col_('carry_forward', 'bool', 'Carry unused days into next year. Policy: FALSE.'),
      col_('active', 'bool', 'Untick to retire.'),
    ],
  },
  {
    name: 'ApprovalFlow', group: 'config', editedBy: 'Admin page',
    purpose: 'Who is asked to approve, by requester role. All rows for a role are notified in parallel.',
    columns: [
      col_('flow_id', 'id', 'Unique ID, e.g. F1.'),
      col_('requester_role', 'enum', 'Role of the person applying.', { values: ENUMS.REQUESTER_ROLE }),
      col_('team_id', 'text', '* = all teams, or a Teams.team_id to override for one team.'),
      col_('approver_rule', 'enum', 'TEAM_LEAD, TEAM_CSUITE, SPECIFIC (uses approver_id) or AUTO.', { values: ENUMS.APPROVER_RULE }),
      col_('approver_id', 'text', 'Employees.emp_id, only for SPECIFIC.'),
      col_('mode', 'enum', 'PARALLEL: everyone notified at once, first approval wins, any rejection overrides.', { values: ENUMS.FLOW_MODE }),
      col_('active', 'bool', 'Untick to switch this rule off.'),
    ],
  },
  {
    name: 'Holidays', group: 'config', editedBy: 'Admin page',
    purpose: 'Company holidays. Skipped when counting leave days.',
    columns: [
      col_('holiday_id', 'id', 'Unique ID, e.g. H-2026-01.'),
      col_('date', 'date', 'Holiday date.'),
      col_('name', 'text', 'Holiday name.'),
      col_('optional', 'bool', 'Optional/restricted holiday (still counted as a working day).'),
      col_('year', 'number', 'Year, for filtering.'),
    ],
  },
  {
    name: 'LeaveBalances', group: 'txn', editedBy: 'System (adjust via Admin page)',
    purpose: 'One row per person × leave type × year. available = accrued + adjusted − used − pending.',
    columns: [
      col_('bal_id', 'id', 'Unique ID, e.g. B0001.'),
      col_('emp_id', 'ref', 'Employees.emp_id', { ref: 'Employees.emp_id' }),
      col_('year', 'number', 'Leave year. No carry-forward: a new row each year.'),
      col_('type_id', 'ref', 'LeaveTypes.type_id', { ref: 'LeaveTypes.type_id' }),
      col_('accrued', 'number', 'Days credited so far this year (quarterly job).'),
      col_('adjusted', 'number', 'Manual +/− by admin. Every change is in AuditLog.'),
      col_('used', 'number', 'Paid days taken (approved requests).'),
      col_('pending', 'number', 'Paid days held by pending requests.'),
      col_('available', 'number', 'accrued + adjusted − used − pending. Written by the app.'),
      col_('last_accrual', 'id', 'Last period credited, e.g. 2026-Q4.'),
      col_('updated_at', 'datetime', 'Row last changed.'),
    ],
  },
  {
    name: 'LeaveRequests', group: 'txn', editedBy: 'System only',
    purpose: 'Every leave request and its final outcome.',
    columns: [
      col_('req_id', 'id', 'Unique ID, e.g. LR-2026-0001.'),
      col_('emp_id', 'ref', 'Who applied (Employees.emp_id).', { ref: 'Employees.emp_id' }),
      col_('type_id', 'ref', 'LeaveTypes.type_id', { ref: 'LeaveTypes.type_id' }),
      col_('start_date', 'date', 'First day of leave.'),
      col_('end_date', 'date', 'Last day of leave.'),
      col_('half_day', 'bool', 'Half-day request (start = end).'),
      col_('days', 'number', 'Working days requested (weekends and holidays skipped).'),
      col_('paid_days', 'number', 'Days covered by balance.'),
      col_('lop_days', 'number', 'Days beyond balance → Loss of Pay.'),
      col_('over_quota', 'bool', 'TRUE if lop_days > 0 at submission.'),
      col_('reason', 'text', 'Reason given by the requester.'),
      col_('status', 'enum', 'PENDING, APPROVED, REJECTED or CANCELLED.', { values: ENUMS.REQ_STATUS }),
      col_('final_by', 'id', 'emp_id whose decision set the final status (or SYSTEM).'),
      col_('final_at', 'datetime', 'When the final status was set.'),
      col_('submitted_at', 'datetime', 'When the request was sent.'),
      col_('cancelled_at', 'datetime', 'When the requester cancelled.'),
      col_('updated_at', 'datetime', 'Row last changed.'),
    ],
  },
  {
    name: 'Approvals', group: 'txn', editedBy: 'System only',
    purpose: 'One row per approver per request. All rows are created together (parallel).',
    columns: [
      col_('appr_id', 'id', 'Unique ID, e.g. A0001.'),
      col_('req_id', 'ref', 'LeaveRequests.req_id', { ref: 'LeaveRequests.req_id' }),
      col_('approver_id', 'id', 'Employees.emp_id, or SYSTEM for auto-approval.'),
      col_('approver_role', 'enum', 'Capacity they approve in.', { values: ENUMS.APPROVER_ROLE }),
      col_('decision', 'enum', 'PENDING, APPROVED, REJECTED, NO_ACTION (closed without acting) or AUTO.', { values: ENUMS.DECISION }),
      col_('comment', 'text', 'Approver comment.'),
      col_('notified_at', 'datetime', 'When Slack/email went out.'),
      col_('decided_at', 'datetime', 'When they decided. Shows who acted first.'),
    ],
  },
  {
    name: 'AuditLog', group: 'log', editedBy: 'System only (append-only)',
    purpose: 'Every change: who, what, when, before → after.',
    columns: [
      col_('log_id', 'id', 'Unique ID, e.g. L000001.'),
      col_('timestamp', 'datetime', 'When it happened.'),
      col_('actor', 'text', 'Email of the person, or "system".'),
      col_('action', 'enum', 'What happened.', { values: ENUMS.AUDIT_ACTION }),
      col_('entity', 'text', 'Tab affected.'),
      col_('entity_id', 'id', 'Row ID affected (or ALL).'),
      col_('field', 'text', 'Column changed, if one.'),
      col_('old_value', 'text', 'Before.'),
      col_('new_value', 'text', 'After.'),
      col_('reason', 'text', 'Why (required for manual adjustments).'),
    ],
  },
];

const TAB_COLORS = { config: '#8AA79B', master: '#1D6B57', txn: '#C98A1B', log: '#7A7A7A', readme: '#355D8C' };


/** Looks up a table definition by tab name. */
function tableDef_(name) {
  for (let i = 0; i < DB_SCHEMA.length; i++) if (DB_SCHEMA[i].name === name) return DB_SCHEMA[i];
  throw new Error('Unknown table: ' + name);
}
