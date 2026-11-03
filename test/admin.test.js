// Reports (person / team / org) with access rules, and admin management. Run: node test/admin.test.js
const assert = require('assert');
const { load } = require('./load');

const P = load({ user: '', now: '2026-11-04T05:00:00Z' });
const { env, run } = P;
run('setupDatabase()'); run('setupDemo()'); env.webapp = true; run('Db.refresh()');
const pick = (k) => run(`apiPick('', '${k}')`).data.session;
const S = { EMP: pick('EMPLOYEE'), INTERN: pick('INTERN'), LEAD: pick('LEAD'), CXO: pick('CXO'), ADMIN: pick('ADMIN') };
const call = (fn, ...args) => run(`${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
const ok = (res, label) => { assert.ok(res.ok, label + ': ' + res.error); return res.data; };
const refused = (res, code, label) => { assert.ok(!res.ok, label + ' should fail'); if (code) assert.strictEqual(res.code, code, label + ': ' + res.error); console.log('  ✓ refused:', label, '→', res.error); };

// ---- report scopes per role
const scopes = (s) => ok(call('apiBootstrap', s), 'boot').reportScopes.map((x) => x.label).join(', ');
assert.strictEqual(scopes(S.EMP), 'Me');
assert.strictEqual(scopes(S.LEAD), 'Me, Test Team');
assert.ok(/^Me, .*Test Team/.test(scopes(S.CXO)));
assert.ok(/Organization$/.test(scopes(S.ADMIN)));
console.log('✓ report scopes · Employee:', scopes(S.EMP), '| Lead:', scopes(S.LEAD), '| CXO:', scopes(S.CXO), '| Admin:', scopes(S.ADMIN));

// some activity: intern takes 2 days in Nov (approved), employee pending
const r1 = ok(call('apiSubmit', S.INTERN, { type_id: 'LT-PL', start_date: '2026-11-19', end_date: '2026-11-20', reason: 'x' }), 'submit');
ok(call('apiDecide', S.LEAD, r1.req_id, 'APPROVED', ''), 'approve');
ok(call('apiSubmit', S.EMP, { type_id: 'LT-SL', start_date: '2026-11-25', end_date: '2026-11-25', reason: 'y' }), 'submit2');

// ---- person report
const me = ok(call('apiReport', S.INTERN, 'person', ''), 'own report');
assert.strictEqual(me.person.name, 'Test Intern'); assert.strictEqual(me.person.lead, 'Test Lead'); assert.strictEqual(me.person.csuite, 'Test CXO');
assert.strictEqual(me.monthly[10].byType['LT-PL'], 2); assert.strictEqual(me.counts.APPROVED, 1);
console.log('✓ intern own report: team', me.person.team_name, '· lead', me.person.lead, '· CXO', me.person.csuite, '· Nov PL', me.monthly[10].byType['LT-PL']);
refused(call('apiReport', S.EMP, 'person', 'E904'), 'FORBIDDEN', 'employee viewing another person');
refused(call('apiReport', S.EMP, 'team', 'T-TEST'), 'FORBIDDEN', 'employee viewing a team');
refused(call('apiReport', S.LEAD, 'org', ''), 'FORBIDDEN', 'lead viewing organization');
refused(call('apiReport', S.LEAD, 'team', 'T-BD'), 'FORBIDDEN', 'lead viewing another team');

// ---- team report (lead)
const team = ok(call('apiReport', S.LEAD, 'team', 'T-TEST'), 'team report');
assert.strictEqual(team.stats.members, 4); assert.strictEqual(team.counts.PENDING, 1); assert.strictEqual(team.stats.daysTaken, 2);
assert.ok(ok(call('apiReport', S.LEAD, 'person', 'E904'), 'lead sees member').person.name === 'Test Intern');
console.log('✓ team report (lead): members', team.stats.members, '· days taken', team.stats.daysTaken, '· pending', team.counts.PENDING,
  '· PL utilisation', team.byType[0].utilization + '%');

// ---- org report (admin)
const org = ok(call('apiReport', S.ADMIN, 'org', ''), 'org report');
assert.ok(org.teams.length >= 5 && org.stats.members === 23);
console.log('✓ org report:', org.stats.members, 'people,', org.teams.length, 'teams:', org.teams.map((t) => t.team_name + ' ' + t.utilization + '%').join(', '));

// ---- admin: overview
refused(call('apiAdminOverview', S.LEAD), 'FORBIDDEN', 'lead opening admin');
let ov = ok(call('apiAdminOverview', S.ADMIN), 'overview');
assert.strictEqual(ov.people.length, 23);
const tl = ov.people.find((p) => p.emp_id === 'E904');
assert.strictEqual(tl.lead, 'Test Lead'); assert.strictEqual(tl.csuite, 'Test CXO');
console.log('✓ admin overview: people', ov.people.length, '· teams', ov.teams.length, '· policies', ov.policies.length);

// ---- admin: add a person
refused(call('apiAdminSavePerson', S.ADMIN, { name: 'X', email: 'bad', role_level: 'EMPLOYEE', emp_type: 'FT', team_id: 'T-SCI', join_date: '2026-11-01' }), 'INVALID', 'bad email');
refused(call('apiAdminSavePerson', S.ADMIN, { name: 'X', email: 'x@d.com', role_level: 'EMPLOYEE', emp_type: 'INT', team_id: 'T-SCI', join_date: '2026-11-01' }), 'INVALID', 'intern without end date');
refused(call('apiAdminSavePerson', S.ADMIN, { name: 'X', email: 'shivakumar.u@darukaa.com', role_level: 'EMPLOYEE', emp_type: 'FT', team_id: 'T-SCI', join_date: '2026-11-01' }), 'CONFLICT', 'duplicate email');
refused(call('apiAdminSavePerson', S.EMP, { name: 'X' }), 'FORBIDDEN', 'employee adding a person');
const added = ok(call('apiAdminSavePerson', S.ADMIN, { name: 'Meera Rao', email: 'Meera@Darukaa.com', role_level: 'EMPLOYEE', emp_type: 'INT',
  team_id: 'T-SCI', join_date: '2026-10-01', end_date: '2027-03-31' }), 'add person');
assert.ok(added.created); assert.strictEqual(added.person.email, 'meera@darukaa.com');
run('Db.refresh()');
const meera = run(`Db.table('Employees').get('${added.person.emp_id}')`);
assert.strictEqual(meera.manager_id, 'E005'); assert.strictEqual(meera.policy_id, 'P-INT'); assert.strictEqual(meera.contract_months, 6);
console.log('✓ added', added.person.emp_id, 'Meera Rao → Science, manager Gaurav, intern policy; balances:', added.balances.join(' | '));
const pv = ok(run(`apiPreview('${S.ADMIN}', {type_id:'LT-PL',start_date:'2026-11-26',end_date:'2026-11-26'})`), 'admin preview');
run(`apiSetViewAs('${S.ADMIN}', '${added.person.emp_id}')`);
const mpv = ok(run(`apiPreview('${S.ADMIN}', {type_id:'LT-PL',start_date:'2026-11-26',end_date:'2026-11-26'})`), 'meera preview');
assert.strictEqual(mpv.approvers.map((a) => a.name).join(' + '), 'Gaurav + Guneet');
run(`apiSetViewAs('${S.ADMIN}', '')`);
console.log('✓ new person\'s leave goes to', mpv.approvers.map((a) => a.name).join(' + '));

// ---- admin: create team, assign lead + approver; members re-pointed
const t = ok(call('apiAdminSaveTeam', S.ADMIN, { team_name: 'Field Ops', lead_id: added.person.emp_id, csuite_id: 'E001' }), 'add team');
run('Db.refresh()');
const meera2 = run(`Db.table('Employees').get('${added.person.emp_id}')`);
assert.strictEqual(t.team_id, 'T-FIELDO'); assert.strictEqual(meera2.team_id, 'T-FIELDO'); assert.strictEqual(meera2.role_level, 'LEAD'); assert.strictEqual(meera2.manager_id, 'E001');
refused(call('apiAdminSaveTeam', S.ADMIN, { team_name: 'Field Ops' }), 'CONFLICT', 'duplicate team name');
refused(call('apiAdminSaveTeam', S.ADMIN, { team_name: 'Z', csuite_id: 'E003' }), 'INVALID', 'non C-suite approver');
console.log('✓ team', t.team_id, 'created; Meera is now its LEAD reporting to Vikram');

// move an employee into it → manager = new lead
ok(call('apiAdminSavePerson', S.ADMIN, Object.assign({}, run(`Db.table('Employees').get('E015')`), { team_id: 'T-FIELDO' })), 'move Harsh');
run('Db.refresh()');
assert.strictEqual(run(`Db.table('Employees').get('E015').manager_id`), added.person.emp_id);
console.log('✓ Harsh moved to Field Ops → manager is now Meera');

// replace lead → old lead becomes EMPLOYEE, members re-pointed
ok(call('apiAdminSaveTeam', S.ADMIN, { team_id: 'T-FIELDO', team_name: 'Field Ops', lead_id: 'E015', csuite_id: 'E001' }), 'replace lead');
run('Db.refresh()');
assert.strictEqual(run(`Db.table('Employees').get('${added.person.emp_id}').role_level`), 'EMPLOYEE');
assert.strictEqual(run(`Db.table('Employees').get('${added.person.emp_id}').manager_id`), 'E015');
assert.strictEqual(run(`Db.table('Employees').get('E015').manager_id`), 'E001');
console.log('✓ lead replaced: Harsh leads, Meera reports to Harsh, Harsh reports to Vikram');

// deactivate the lead → team lead slot cleared
ok(call('apiAdminSavePerson', S.ADMIN, Object.assign({}, run(`Db.table('Employees').get('E015')`), { status: 'Inactive' })), 'deactivate');
run('Db.refresh()');
assert.strictEqual(run(`Db.table('Teams').get('T-FIELDO').lead_id`), '');
assert.strictEqual(run(`Db.table('Employees').get('${added.person.emp_id}').manager_id`), 'E001');
console.log('✓ deactivated lead → team lead cleared, members fall back to the C-suite approver');

// ---- balances & quotas
refused(call('apiAdminAdjustBalance', S.ADMIN, 'E903', 'LT-PL', 1.3, 'x'), 'INVALID', 'non half-day step');
refused(call('apiAdminAdjustBalance', S.ADMIN, 'E903', 'LT-PL', 2, ''), 'INVALID', 'no reason');
const before = ok(call('apiReport', S.EMP, 'person', ''), 'r').person.balances.find((b) => b.code === 'PL').available;
const after = ok(call('apiAdminAdjustBalance', S.ADMIN, 'E903', 'LT-PL', 2, 'Comp-off for weekend event'), 'adjust').find((b) => b.code === 'PL').available;
assert.strictEqual(after, before + 2);
console.log('✓ adjust balance: Test Employee PL', before, '→', after);
ok(call('apiAdminSaveQuota', S.ADMIN, 'PR-01', 24), 'quota');
run('Db.refresh()'); assert.strictEqual(run(`Db.table('Policies').get('PR-01').yearly_quota`), 24);
refused(call('apiAdminSaveQuota', S.ADMIN, 'PR-01', -1), 'INVALID', 'negative quota');
console.log('✓ quota PR-01 (Full-time Paid) 20 → 24');

const audits = run(`Db.table('AuditLog').where(a => /Admin|Made team lead|Replaced|no longer/.test(a.reason) || a.action==='ADJUST').length`);
assert.ok(audits >= 8); console.log('✓ every admin change audited (' + audits + ' rows)');

// integrity
run('Db.refresh()');
const reqs = run("Db.table('LeaveRequests').all()");
run("Db.table('LeaveBalances').all()").forEach((b) => {
  const mine = reqs.filter((r) => r.emp_id === b.emp_id && r.type_id === b.type_id);
  const sum = (s) => mine.filter((r) => r.status === s).reduce((t, r) => t + r.paid_days, 0);
  assert.strictEqual(b.used, sum('APPROVED')); assert.strictEqual(b.pending, sum('PENDING'));
  assert.strictEqual(b.available, b.accrued + b.adjusted - b.used - b.pending);
});
console.log('✓ all balances still reconcile');
console.log('\nADMIN TESTS PASSED');
