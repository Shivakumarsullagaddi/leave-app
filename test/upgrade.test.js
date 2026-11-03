// An older sheet (made before the Test Team existed) upgraded with setupTestTeam().
// Real Sheets rejects dropdown values that don't exist yet; the mock enforces that too.
const assert = require('assert');
const { load } = require('./load');

const P = load({ user: 'shivakumar.u@darukaa.com', now: '2026-11-04T05:00:00Z' });
const { env, run } = P;
run('setupDatabase()');

// Remove everything the Test Team added, like a sheet built by the first Setup.gs.
const clearRows = (tab, test) => {
  const sh = env.book.getSheetByName(tab);
  const values = sh.getDataRange().getValues();
  values.forEach((row, i) => { if (i > 0 && test(row)) sh.getRange(i + 1, 1, 1, row.length).clearContent(); });
};
clearRows('Teams', (r) => r[0] === 'T-TEST');
clearRows('Employees', (r) => /^E90/.test(r[0]));
clearRows('LeaveBalances', (r) => /^E90/.test(r[1]));
run(`Db.refresh();
  Db.table('Employees').update('E002',{email:'shivakumarullagaddi855@gmail.com'});
  Db.table('Employees').update('E004',{email:'shivakumarullagaddi56@gmail.com'});
  Db.table('Employees').update('E011',{email:'shivakumar.u@darukaa.com'});`);
assert.strictEqual(run("Db.refresh(); Db.table('Teams').get('T-TEST')"), null);

run('setupTestTeam()');
run('setupTestTeam()'); // and again: safe to re-run
run('Db.refresh()');
const team = run("Db.table('Teams').get('T-TEST')");
assert.strictEqual(team.lead_id, 'E902'); assert.strictEqual(team.csuite_id, 'E901');
const lead = run("Db.table('Employees').get('E902')");
assert.strictEqual(lead.team_id, 'T-TEST'); assert.strictEqual(lead.manager_id, 'E901');
assert.strictEqual(run("Db.table('Employees').get('E903').manager_id"), 'E902');
assert.strictEqual(run("Db.table('Employees').get('E011').email"), 'shiva@darukaa.com');
assert.strictEqual(run("Db.table('LeaveBalances').where(b=>/^E90/.test(b.emp_id)).length"), 6);
P.env.webapp = true;
const pv = run(`apiPreview('', {type_id:'LT-PL',start_date:'2026-11-26',end_date:'2026-11-26'})`).data;
assert.strictEqual(pv.approvers.map((a) => a.name).join(' + '), 'Test Lead + Test CXO');
console.log('✓ old sheet upgraded: Test Team, people, balances; Test Employee →', pv.approvers.map((a) => a.name).join(' + '));
console.log('UPGRADE TEST PASSED');
