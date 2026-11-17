// End-to-end test of the backend against in-memory Apps Script mocks.
// Run: node test/flow.test.js
const assert = require('assert');
const { load } = require('./load');

const P = load({ user: 'shivakumar.u@darukaa.com', now: '2026-11-03T05:00:00Z' }); // 10:30 IST
const { env, run } = P;
const ok = (res, label) => { if (!res.ok) throw new Error(label + ': ' + res.error); return res.data; };
const refused = (res, code, label) => {
  assert.strictEqual(res.ok, false, label + ' should fail');
  if (code) assert.strictEqual(res.code, code, label + ': ' + res.error);
  console.log('  ✓ refused:', label, '→', res.error);
};
const as = (email) => { env.user = email; run('Db.refresh()'); };
const viewAs = (id) => ok(run(`apiSetViewAs('', '${id}')`), 'view as ' + id);
const bal = (emp, type) => run(`Db.refresh(); Db.table('LeaveBalances').find(b=>b.emp_id==='${emp}'&&b.type_id==='${type}')`);

// --- setup
run('setupDatabase()');
// Simulate the live sheet: old mapping put the test emails on Guneet, Jaya and Shiva.
run(`Db.refresh();
  Db.table('Employees').update('E002',{email:'shivakumarullagaddi855@gmail.com'});
  Db.table('Employees').update('E004',{email:'shivakumarullagaddi56@gmail.com'});
  Db.table('Employees').update('E011',{email:'shivakumar.u@darukaa.com'});`);
run('setupTestTeam()');
run('setupTestTeam()'); // safe to re-run
run('Db.refresh()');
assert.strictEqual(run("Db.table('Employees').get('E011').email"), 'shiva@darukaa.com');
assert.strictEqual(run("Db.table('Employees').get('E004').email"), 'jaya@darukaa.com');
assert.strictEqual(run("Db.table('Employees').where(e=>e.email==='shivakumar.u@darukaa.com').length"), 1);
assert.strictEqual(run("Db.table('LeaveBalances').where(b=>b.emp_id==='E903').length"), 2);
console.log('✓ test team set up; dummy people got placeholder emails back');
console.log('tabs:', env.book.sheets.map((s) => s.name).join(', '));
assert.strictEqual(P.props.SPREADSHEET_ID, 'BOOK1');
run('setupDatabase()'); // re-run is safe
run('Db.refresh()');
assert.strictEqual(run("Db.table('Employees').all().length"), 23);
assert.strictEqual(run("Db.table('LeaveRequests').all().length"), 13);
assert.ok(run("Config.bool('TEST_MODE')"));
console.log('✓ setup idempotent: 23 employees (18 + 5 personas), 13 requests, TEST_MODE on');

// From here on behave like the deployed web app (no active spreadsheet).
env.webapp = true;

// --- signed-in test employee (E903)
as('shivakumar.u@darukaa.com');
let boot = ok(run("apiBootstrap('')"), 'bootstrap');
assert.strictEqual(boot.me.emp_id, 'E903');
assert.strictEqual(boot.me.team_name, 'Test Team');
assert.ok(boot.identity.isAdmin);
console.log('✓ bootstrap as', boot.me.name, '·', boot.me.team_name, '·', boot.balances.map((b) => b.code + ' ' + b.available).join(', '));

let pv = ok(run(`apiPreview('', {type_id:'LT-PL',start_date:'2026-11-19',end_date:'2026-11-23'})`), 'preview');
assert.strictEqual(pv.days, 3);
assert.strictEqual(pv.lop, 0);
assert.strictEqual(pv.approvers.map((a) => a.name).join(), ['Test Lead', 'Test CXO'].join());
console.log('✓ preview Thu–Mon = 3 days; approvers', pv.approvers.map((a) => a.name + '/' + a.role).join(', '));

refused(run(`apiPreview('', {type_id:'LT-PL',start_date:'2026-11-21',end_date:'2026-11-22'})`), 'INVALID', 'weekend only');
refused(run(`apiPreview('', {type_id:'LT-PL',start_date:'2026-11-23',end_date:'2026-11-19'})`), 'INVALID', 'end before start');
refused(run(`apiPreview('', {type_id:'LT-PL',start_date:'2026-12-30',end_date:'2027-01-02'})`), 'INVALID', 'crosses year');

const r1 = ok(run(`apiSubmit('', {type_id:'LT-PL',start_date:'2026-11-19',end_date:'2026-11-23',reason:'Trip'})`), 'submit');
assert.strictEqual(r1.status, 'PENDING');
assert.strictEqual(r1.approvals.length, 2);
assert.strictEqual(bal('E903', 'LT-PL').pending, 3);
assert.strictEqual(bal('E903', 'LT-PL').available, 20, 'pending days are not taken off the balance');
console.log('✓ submitted', r1.req_id, '· 3 days waiting for approval, balance still 20 · email to', env.mail.at(-1).to);
refused(run(`apiSubmit('', {type_id:'LT-PL',start_date:'2026-11-20',end_date:'2026-11-20'})`), 'CONFLICT', 'overlapping dates');

// --- Test Lead approves first
viewAs('E902');
boot = ok(run("apiBootstrap('')"), 'boot test lead');
assert.strictEqual(boot.me.name, 'Test Lead');
assert.ok(boot.identity.viewingAs);
assert.ok(boot.inbox.waiting.some((r) => r.req_id === r1.req_id));
console.log('✓ viewing as Test Lead; waiting:', boot.inbox.waiting.map((r) => r.req_id + ' ' + r.employee.name).join(', '));
refused(run(`apiDecide('', '${r1.req_id}','REJECTED','')`), 'INVALID', 'reject without reason');
const d1 = ok(run(`apiDecide('', '${r1.req_id}','APPROVED','Fine')`), 'lead approve');
assert.strictEqual(d1.status, 'APPROVED');
assert.strictEqual(d1.final_by, 'E902');
assert.strictEqual(bal('E903', 'LT-PL').used, 3);
assert.strictEqual(bal('E903', 'LT-PL').pending, 0);
refused(run(`apiDecide('', '${r1.req_id}','APPROVED','again')`), 'CONFLICT', 'second decision by same person');
console.log('✓ first approval → APPROVED; days moved pending → used');

// --- Test CXO also approves later: both on record
viewAs('E901');
env.today = '2026-11-03T09:00:00Z'; // 14:30 IST
const d2 = ok(run(`apiDecide('', '${r1.req_id}','APPROVED','')`), 'cxo approve');
assert.strictEqual(d2.status, 'APPROVED');
console.log('✓ both approvals on record:', d2.approvals.map((a) => a.name + ' ' + a.decision + ' ' + a.decided_at).join(' | '));

// --- approve then reject → rejected, balance reverted
viewAs('E011');
const r2 = ok(run(`apiSubmit('', {type_id:'LT-SL',start_date:'2026-12-01',end_date:'2026-12-01',half_day:true,reason:'Dentist'})`), 'half day');
assert.strictEqual(r2.days, 0.5);
viewAs('E004'); ok(run(`apiDecide('', '${r2.req_id}','APPROVED','')`), 'jaya ok');
assert.strictEqual(bal('E011', 'LT-SL').used, 0.5);
viewAs('E002');
const d3 = ok(run(`apiDecide('', '${r2.req_id}','REJECTED','Team offsite that day')`), 'guneet reject');
assert.strictEqual(d3.status, 'REJECTED');
assert.strictEqual(d3.final_by, 'E002');
assert.strictEqual(bal('E011', 'LT-SL').used, 0);
console.log('✓ approved then rejected → REJECTED; used back to 0');

// --- lock once the leave starts
viewAs('E011');
const r3 = ok(run(`apiSubmit('', {type_id:'LT-PL',start_date:'2026-11-04',end_date:'2026-11-04',reason:'x'})`), 'r3');
viewAs('E004'); ok(run(`apiDecide('', '${r3.req_id}','APPROVED','')`), 'approve r3');
env.today = '2026-11-04T05:00:00Z';
viewAs('E002');
refused(run(`apiDecide('', '${r3.req_id}','REJECTED','late')`), 'CONFLICT', 'reject after leave started');
boot = ok(run("apiBootstrap('')"), 'boot guneet');
assert.ok(!boot.inbox.waiting.some((r) => r.req_id === r3.req_id));
console.log('✓ locked request leaves the inbox; Guneet waiting:', boot.inbox.waiting.map((r) => r.req_id).join(', '));

// --- cancel
viewAs('E011');
const r4 = ok(run(`apiSubmit('', {type_id:'LT-PL',start_date:'2026-12-14',end_date:'2026-12-15',reason:'y'})`), 'r4');
const before = bal('E011', 'LT-PL');
const c = ok(run(`apiCancel('', '${r4.req_id}')`), 'cancel');
assert.strictEqual(c.status, 'CANCELLED');
assert.strictEqual(bal('E011', 'LT-PL').available, before.available, 'balance never moved');
assert.strictEqual(bal('E011', 'LT-PL').pending, before.pending - 2, 'the 2 waiting days are released');
assert.ok(c.approvals.every((a) => a.decision === 'NO_ACTION'));
viewAs('E903');
refused(run(`apiCancel('', '${r1.req_id}')`), 'CONFLICT', 'cancel an approved request');
console.log('✓ cancel gives the days back');

// --- routing for leads and C-suite
viewAs('E003');
pv = ok(run(`apiPreview('', {type_id:'LT-PL',start_date:'2026-12-07',end_date:'2026-12-08'})`), 'ankita');
assert.strictEqual(pv.approvers.map((a) => a.name + ':' + a.role).join(), 'Vikram:CSUITE,Test Employee:ADMIN');
console.log('✓ team lead Ankita → Vikram, plus the admin (ADMIN_EMAILS) in parallel');

// --- the admin can approve too: first approval wins, the C-suite row is closed as no longer needed
const rAdm = ok(run(`apiSubmit('', {type_id:'LT-PL',start_date:'2026-12-10',end_date:'2026-12-10',reason:'admin test'})`), 'ankita submit');
assert.strictEqual(rAdm.approvals.map((a) => a.approver_id + ':' + a.role + ':' + a.decision).join(), 'E001:CSUITE:PENDING,E903:ADMIN:PENDING');
viewAs('E903');
assert.ok(ok(run("apiBootstrap('')"), 'admin boot').inbox.waiting.some((r) => r.req_id === rAdm.req_id), 'request is in the admin inbox');
const admDone = ok(run(`apiDecide('', '${rAdm.req_id}','APPROVED','ok from admin')`), 'admin approves');
assert.strictEqual(admDone.status, 'APPROVED'); assert.strictEqual(admDone.final_by, 'E903');
// switching the rule off in the sheet removes the admin from new requests; setupDatabase never re-adds an existing row
run(`Db.table('ApprovalFlow').update('F6', { active: false })`); env.webapp = false; run('setupDatabase()'); env.webapp = true; run('Db.refresh()');
assert.strictEqual(run("Db.table('ApprovalFlow').get('F6').active"), false);
viewAs('E003');
assert.strictEqual(ok(run(`apiPreview('', {type_id:'LT-PL',start_date:'2026-12-21',end_date:'2026-12-21'})`), 'ankita off').approvers.map((a) => a.name).join(), 'Vikram');
run(`Db.table('ApprovalFlow').update('F6', { active: true })`); run('Db.refresh()');
console.log('✓ admin approved', rAdm.req_id, '(ADMIN rule); unticking F6 in ApprovalFlow switches it off');
viewAs('E001');
const r5 = ok(run(`apiSubmit('', {type_id:'LT-PL',start_date:'2026-12-09',end_date:'2026-12-09',reason:'z'})`), 'vikram');
assert.strictEqual(r5.status, 'APPROVED');
assert.strictEqual(r5.final_by, 'SYSTEM');
assert.strictEqual(bal('E001', 'LT-PL').used, 1);
console.log('✓ C-suite auto-approved', r5.req_id);

// --- over quota → LOP
viewAs('E006');
pv = ok(run(`apiPreview('', {type_id:'LT-PL',start_date:'2026-12-16',end_date:'2026-12-18'})`), 'arshad');
assert.ok(pv.overQuota);
assert.strictEqual(pv.lop, 3);
const r6 = ok(run(`apiSubmit('', {type_id:'LT-PL',start_date:'2026-12-16',end_date:'2026-12-18',reason:'Family'})`), 'arshad submit');
assert.strictEqual(r6.lop_days, 3);
console.log('✓ over quota allowed: 3 days → 0 paid + 3 LOP; sent to', r6.approvals.map((a) => a.name).join(' + '));

// --- access control
viewAs('');
as('stranger@gmail.com');
boot = ok(run("apiBootstrap('')"), 'stranger');
assert.strictEqual(boot.me, null);
refused(run("apiPreview('', {})"), 'NOT_REGISTERED', 'unknown account');
refused(run(`apiSetViewAs('', 'E001')`), 'FORBIDDEN', 'view-as by non-admin');

// --- Slack takes over from email when enabled
as('shivakumar.u@darukaa.com');
run(`Db.table('Settings').update('SLACK_ENABLED',{value:'TRUE'});
     PropertiesService.getScriptProperties().setProperty('SLACK_BOT_TOKEN','xoxb-test');`);
env.slackReply = (m, p) => (m === 'users.lookupByEmail' ? { ok: true, user: { id: 'U-' + p.email.split('@')[0] } } : { ok: true });
const mails = env.mail.length;
viewAs('E012');
ok(run(`apiSubmit('', {type_id:'LT-SL',start_date:'2026-12-21',end_date:'2026-12-21',reason:'Checkup'})`), 'hardik');
assert.strictEqual(env.mail.length, mails);
const dms = env.slack.filter((c) => c.method === 'chat.postMessage');
assert.ok(dms.length >= 1 && dms.every((c) => /^U-/.test(c.payload.channel)), 'approvers get DMs');
const card = dms.at(-1).payload.blocks;
assert.strictEqual(card[0].type, 'header');
assert.ok(card.some((b) => b.type === 'actions' && b.elements.some((e) => e.action_id === 'approve')), 'approver card has an Approve button');
console.log('✓ Slack DMs used when enabled → ' + dms.map((c) => c.payload.channel).join(', ') + ':', card[0].text.text, '·', card[1].text.text);

// --- integrity: every balance equals what its requests say
run('Db.refresh()');
const reqs = run("Db.table('LeaveRequests').all()");
run("Db.table('LeaveBalances').all()").forEach((b) => {
  const mine = reqs.filter((r) => r.emp_id === b.emp_id && r.type_id === b.type_id);
  const sum = (s) => mine.filter((r) => r.status === s).reduce((t, r) => t + r.paid_days, 0);
  assert.strictEqual(b.used, sum('APPROVED'), b.bal_id + ' used');
  assert.strictEqual(b.pending, sum('PENDING'), b.bal_id + ' pending');
  assert.strictEqual(b.available, b.accrued + b.adjusted - b.used, b.bal_id + ' available');
});
const ids = env.book.getSheetByName('LeaveRequests').getRange(2, 1, 40, 1).getValues().map((r) => r[0]).filter(Boolean);
assert.strictEqual(ids.length, reqs.length, 'new rows are written right under existing data');
console.log('✓ all balances reconcile; rows contiguous; audit rows:', run("Db.table('AuditLog').all().length"));
console.log('\nALL TESTS PASSED');
