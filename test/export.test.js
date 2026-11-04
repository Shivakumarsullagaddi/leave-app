// Report download data (CSV / PDF) for every role and period. Run: node test/export.test.js
const assert = require('assert');
const { load } = require('./load');

const P = load({ user: '', now: '2026-11-04T05:00:00Z' });
const { env, run } = P;
run('setupDatabase()'); run('setupDemo()'); env.webapp = true; run('Db.refresh()');
const pick = (k) => run(`apiPick('', '${k}')`).data.session;
const S = { EMP: pick('EMPLOYEE'), INTERN: pick('INTERN'), LEAD: pick('LEAD'), CXO: pick('CXO'), ADMIN: pick('ADMIN') };
const call = (fn, ...args) => run(`${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
const ok = (res, label) => { assert.ok(res.ok, label + ': ' + res.error); return res.data; };
const exp = (s, scope, id, from, to) => call('apiReportExport', s, scope, id, from, to);
const col = (t, key) => t.columns.findIndex((c) => c.key === key);

// leave spanning Oct → Nov (Fri 30 Oct, Mon 2 Nov, Tue 3 Nov = 3 working days), approved
const r1 = ok(call('apiSubmit', S.INTERN, { type_id: 'LT-PL', start_date: '2026-10-30', end_date: '2026-11-03', reason: '=cmd|calc' }), 'submit');
ok(call('apiDecide', S.LEAD, r1.req_id, 'APPROVED', ''), 'approve');
ok(call('apiSubmit', S.EMP, { type_id: 'LT-SL', start_date: '2026-11-25', end_date: '2026-11-25', reason: 'Doctor, "checkup"' }), 'pending');

// ---- person, own report, November only: 2 of the 3 days fall in the period
const nov = ok(exp(S.INTERN, 'person', '', '2026-11-01', '2026-11-30'), 'intern nov');
assert.strictEqual(nov.title, 'Test Intern');
assert.strictEqual(nov.filename, 'leave-report_test-intern_2026-11-01_to_2026-11-30');
const [sum, reqs] = nov.tables;
assert.strictEqual(sum.rows.length, 1); assert.strictEqual(reqs.rows.length, 1);
assert.strictEqual(reqs.rows[0][col(reqs, 'days')], 3);
assert.strictEqual(reqs.rows[0][col(reqs, 'in_period')], 2);
assert.strictEqual(sum.rows[0][col(sum, 'days')], 2);
assert.strictEqual(reqs.rows[0][col(reqs, 'by')], 'Test Lead');
assert.ok(sum.columns.some((c) => c.label === 'PL left 2026') && sum.columns.some((c) => c.label === 'SL credited 2026'));
console.log('✓ intern, November: request Oct 30–Nov 3 counts 2 of 3 days; approver + PL/SL balances included');

const oct = ok(exp(S.INTERN, 'person', '', '2026-10-01', '2026-10-31'), 'oct');
assert.strictEqual(oct.tables[1].rows[0][col(oct.tables[1], 'in_period')], 1);
const sep = ok(exp(S.INTERN, 'person', '', '2026-09-01', '2026-09-30'), 'sep');
assert.strictEqual(sep.tables[1].rows.length, 0);
console.log('✓ October counts 1 day; September has no requests');

// ---- who can download what
assert.strictEqual(exp(S.EMP, 'person', 'E904', '2026-01-01', '2026-12-31').code, 'FORBIDDEN');
assert.strictEqual(exp(S.EMP, 'team', 'T-TEST', '2026-01-01', '2026-12-31').code, 'FORBIDDEN');
assert.strictEqual(exp(S.LEAD, 'org', '', '2026-01-01', '2026-12-31').code, 'FORBIDDEN');
const teamId = ok(call('apiBootstrap', S.LEAD), 'boot').reportScopes.find((x) => x.scope === 'team').id;
const team = ok(exp(S.LEAD, 'team', teamId, '2026-01-01', '2026-12-31'), 'lead team');
assert.ok(team.tables[0].rows.length >= 4 && team.tables[1].rows.length === 2);
ok(exp(S.LEAD, 'person', 'E904', '2026-01-01', '2026-12-31'), 'lead → member');
ok(exp(S.CXO, 'team', teamId, '2026-01-01', '2026-12-31'), 'cxo team');
const org = ok(exp(S.ADMIN, 'org', '', '2026-01-01', '2026-12-31'), 'admin org');
assert.ok(org.tables[0].rows.length >= 23);
console.log('✓ employee: own only · lead/CXO: their team · admin: organization (' + org.tables[0].rows.length + ' people)');

// ---- period checks
assert.ok(/on or before/.test(exp(S.EMP, 'person', '', '2026-12-01', '2026-11-01').error));
assert.ok(/at most 2 years/.test(exp(S.EMP, 'person', '', '2024-01-01', '2026-12-31').error));
assert.ok(/valid/.test(exp(S.EMP, 'person', '', '2026-02-30', '2026-03-01').error));
ok(exp(S.EMP, 'person', '', '2025-01-01', '2026-12-31'), '2 years allowed');
const last = ok(exp(S.EMP, 'person', '', '2025-01-01', '2025-12-31'), 'last year');
assert.strictEqual(last.balanceYear, 2025);
const future = ok(exp(S.EMP, 'person', '', '2027-01-01', '2027-03-31'), 'next year');
assert.strictEqual(future.balanceYear, 2026);
console.log('✓ period: From ≤ To, max 2 years, real dates; balances use the leave year of "To" (never beyond this year)');

console.log('\nEXPORT TESTS PASSED');
