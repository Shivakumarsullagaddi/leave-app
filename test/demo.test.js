// Prototype entrance (role picker) + admin dashboard. Run: node test/demo.test.js
const assert = require('assert');
const { load } = require('./load');

const P = load({ user: '', now: '2026-11-04T05:00:00Z' });
const { env, run } = P;
run('setupDatabase()');
// Like the live sheet: an earlier failed run left nobody holding the test emails.
run(`Db.refresh(); Db.table('Employees').update('E903',{email:'old@darukaa.com'});`);
run('setupDemo()');
run('setupDemo()'); // safe to re-run
env.webapp = true;
run('Db.refresh()');
assert.strictEqual(P.props.LOGIN_MODE, 'PICKER');

let boot = run("apiBootstrap('')").data;
assert.ok(boot.needsLogin && boot.auth.mode === 'picker' && !boot.balances && !boot.loginUrl);
assert.strictEqual(boot.personas.map((p) => p.label).join(', '), 'Employee, Intern, Team Lead, CXO, Admin');
assert.ok(boot.personas.every((p) => p.ready));
console.log('✓ entrance shows:', boot.personas.map((p) => p.label + ' → ' + p.name).join(' | '));

const pick = (persona) => { const r = run(`apiPick('', '${persona}', ${JSON.stringify(P.props.ADMIN_PASSCODE)})`); assert.ok(r.ok, persona + ': ' + r.error); return r.data.session; };
const S = {};
['EMPLOYEE', 'INTERN', 'LEAD', 'CXO', 'ADMIN'].forEach((k) => { S[k] = pick(k); });
const who = (k) => run(`apiBootstrap('${S[k]}')`).data;

const emp = who('EMPLOYEE'), intern = who('INTERN'), lead = who('LEAD'), cxo = who('CXO'), admin = who('ADMIN');
assert.strictEqual(emp.me.name, 'Test Employee'); assert.strictEqual(emp.me.emp_type, 'FT'); assert.ok(!emp.isAdmin);
assert.strictEqual(intern.me.name, 'Test Intern'); assert.strictEqual(intern.me.emp_type, 'INT');
assert.strictEqual(lead.me.role_level, 'LEAD'); assert.strictEqual(cxo.me.role_level, 'CSUITE');
assert.strictEqual(admin.me.name, 'Leave Admin'); assert.ok(admin.isAdmin && admin.identity.isAdmin);
const bal = (b, code) => b.balances.find((x) => x.code === code).available;
console.log('✓ Employee  → Test Employee, Full-time, PL', bal(emp, 'PL'), 'SL', bal(emp, 'SL'));
console.log('✓ Intern    → Test Intern, Intern (Sep–Feb), PL', bal(intern, 'PL'), 'SL', bal(intern, 'SL'), '(prorated)');
console.log('✓ Team Lead → Test Lead · CXO → Test CXO · Admin → Leave Admin (admin)');
assert.strictEqual(bal(intern, 'PL'), 6.5); assert.strictEqual(bal(intern, 'SL'), 4);

// Approval routing per persona
const approvers = (k) => run(`apiPreview('${S[k]}', {type_id:'LT-PL',start_date:'2026-11-26',end_date:'2026-11-26'})`).data;
assert.strictEqual(approvers('EMPLOYEE').approvers.map((a) => a.name).join(' + '), 'Test Lead + Test CXO');
assert.strictEqual(approvers('INTERN').approvers.map((a) => a.name).join(' + '), 'Test Lead + Test CXO');
assert.strictEqual(approvers('LEAD').approvers.map((a) => a.name).join(' + '), 'Test CXO');
assert.ok(approvers('CXO').autoApprove);
console.log('✓ routing: Employee/Intern → Test Lead + Test CXO; Team Lead → Test CXO; CXO auto');

// Full flow
const r1 = run(`apiSubmit('${S.INTERN}', {type_id:'LT-SL',start_date:'2026-11-26',end_date:'2026-11-26',reason:'Fever'})`).data;
const r2 = run(`apiSubmit('${S.EMPLOYEE}', {type_id:'LT-PL',start_date:'2026-12-01',end_date:'2026-12-02',reason:'Trip'})`).data;
assert.strictEqual(who('LEAD').inbox.waiting.filter((r) => [r1.req_id, r2.req_id].includes(r.req_id)).length, 2);
assert.strictEqual(run(`apiDecide('${S.LEAD}', '${r1.req_id}', 'APPROVED', 'Get well')`).data.status, 'APPROVED');
assert.strictEqual(run(`apiDecide('${S.CXO}', '${r2.req_id}', 'REJECTED', 'Client visit')`).data.status, 'REJECTED');
console.log('✓ intern applied → lead approved; employee applied → CXO rejected');

// Admin dashboard
assert.strictEqual(run(`apiAdminOverview('${S.EMPLOYEE}')`).code, 'FORBIDDEN');
const ov = run(`apiAdminOverview('${S.ADMIN}')`).data;
assert.ok(ov.report.stats.members >= 23 && ov.requests.length >= 15 && ov.people.length >= ov.report.stats.members && ov.teams.length >= 1);
assert.ok(ov.requests.some((r) => r.req_id === r1.req_id && r.status === 'APPROVED'));
console.log('✓ admin dashboard:', JSON.stringify(ov.report.stats));
console.log('  employee is refused the admin dashboard');

// Switch role
run(`apiSignOut('${S.EMPLOYEE}')`);
assert.ok(run(`apiBootstrap('${S.EMPLOYEE}')`).data.needsLogin);
console.log('✓ "Switch role" returns to the entrance');
console.log('\nDEMO TESTS PASSED');
