// Admin passcode on the prototype entrance. Run: node test/passcode.test.js
const assert = require('assert');
const { load } = require('./load');

const P = load({ user: '', now: '2026-11-04T05:00:00Z' });
const { env, run } = P;
run('setupDatabase()');

// before setupDemo created a passcode: Admin is locked with a clear message
run('setupDemo()');
const code = P.props.ADMIN_PASSCODE;
assert.ok(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code), 'setupDemo creates a passcode like 7KQ4-M9TX: ' + code);
run('setupDemo()');
assert.strictEqual(P.props.ADMIN_PASSCODE, code, 're-running setupDemo keeps the passcode');
console.log('✓ setupDemo creates the admin passcode once and keeps it');
env.webapp = true; run('Db.refresh()');

const pick = (persona, pc) => run(`apiPick('', ${JSON.stringify(persona)}, ${JSON.stringify(pc)})`);
const boot = run("apiBootstrap('')").data;
assert.strictEqual(boot.personas.filter((p) => p.needsPasscode).map((p) => p.persona).join(), 'ADMIN');
console.log('✓ only the Admin button asks for a passcode');

assert.ok(pick('EMPLOYEE', '').ok && pick('CXO', '').ok, 'other roles need no passcode');
let r = pick('ADMIN', '');
assert.ok(!r.ok && r.code === 'FORBIDDEN' && /4 tries left/.test(r.error), r.error);
r = pick('ADMIN', 'wrong');
assert.ok(!r.ok && /3 tries left/.test(r.error), r.error);
r = pick('ADMIN', code);
assert.ok(r.ok, r.error);
const admin = r.data.session;
assert.ok(run(`apiBootstrap('${admin}')`).data.isAdmin);
console.log('✓ wrong passcode refused, right one opens Admin');

// a success clears the counter; 5 wrong tries lock it, even for the right passcode
for (let i = 0; i < 5; i++) pick('ADMIN', 'nope' + i);
r = pick('ADMIN', code);
assert.ok(!r.ok && /locked for 15 minutes/.test(r.error), r.error);
console.log('✓ 5 wrong tries lock Admin:', r.error);
run(`CacheService.getScriptCache().remove('admin_passcode_fails')`); // as if 15 minutes passed

// change the passcode from the Admin UI
const change = (s, a, b) => run(`apiAdminChangePasscode(${JSON.stringify(s)}, ${JSON.stringify(a)}, ${JSON.stringify(b)})`);
const emp = pick('EMPLOYEE', '').data.session;
assert.strictEqual(change(emp, code, 'newpass1').code, 'FORBIDDEN');
assert.ok(!change(admin, 'bad', 'newpass1').ok);
assert.ok(/at least 6/.test(change(admin, code, 'abc').error));
assert.ok(change(admin, code, 'Darukaa-2026').ok);
assert.strictEqual(P.props.ADMIN_PASSCODE, 'Darukaa-2026');
assert.ok(!pick('ADMIN', code).ok && pick('ADMIN', 'Darukaa-2026').ok);
const log = run(`Db.table('AuditLog').where((l) => l.entity_id === 'ADMIN_PASSCODE')`);
assert.ok(log.length === 1 && !JSON.stringify(log).includes('Darukaa-2026'), 'audited without the value');
console.log('✓ admin changed the passcode; old one stops working; audit hides the value');

// no passcode at all → clear setup message
run(`PropertiesService.getScriptProperties().deleteProperty('ADMIN_PASSCODE')`);
r = pick('ADMIN', 'anything');
assert.ok(!r.ok && /run setupDemo/i.test(r.error), r.error);
console.log('✓ missing passcode →', r.error);

console.log('\nPASSCODE TESTS PASSED');
