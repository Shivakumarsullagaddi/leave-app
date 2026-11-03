// Google sign-in (OAuth code flow) against mocks. Run: node test/auth.test.js
const assert = require('assert');
const { load } = require('./load');

const P = load({ user: '', now: '2026-11-03T05:00:00Z' }); // web app sees no Google user
const { env, run } = P;
const CLIENT = '123-abc.apps.googleusercontent.com';

run('setupDatabase()');
run('setupTestTeam()');
env.webapp = true;
run(`Db.refresh(); Db.table('Settings').update('APP_URL',{value:'https://script.google.com/macros/s/LIVE/exec'});`);

// --- Auth off: behaves as before (no login screen)
let boot = run("apiBootstrap('')").data;
assert.strictEqual(boot.auth.enabled, false);
assert.strictEqual(boot.loginUrl, undefined);
console.log('✓ without OAuth keys the app falls back to the Google session');

// --- Auth on
run(`PropertiesService.getScriptProperties().setProperty('OAUTH_CLIENT_ID','${CLIENT}');
     PropertiesService.getScriptProperties().setProperty('OAUTH_CLIENT_SECRET','s3cret');`);
boot = run("apiBootstrap('', {view:'approvals', req:'LR-2026-0012'})").data;
assert.ok(boot.auth.enabled && !boot.auth.signedIn);
const url = new URL(boot.loginUrl);
assert.strictEqual(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
assert.strictEqual(url.searchParams.get('client_id'), CLIENT);
assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://script.google.com/macros/s/LIVE/exec');
assert.strictEqual(url.searchParams.get('scope'), 'openid email profile');
const state = url.searchParams.get('state');
assert.ok(/^[a-f0-9]{64}$/.test(state));
assert.strictEqual(boot.me, null);
assert.strictEqual(boot.balances, undefined, 'no data before sign-in');
assert.strictEqual(run(`apiPreview('', {})`).code, 'UNAUTHENTICATED');
console.log('✓ signed-out visitors get only a sign-in link (state', state.slice(0, 8) + '…) and no data');

const idToken = (claims) => 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.sig';
const good = (email) => ({ aud: CLIENT, iss: 'https://accounts.google.com', exp: Date.parse(env.today) / 1000 + 3600, email, email_verified: true });
const respond = (claims) => { env.tokenResponse = { code: 200, body: JSON.stringify({ id_token: idToken(claims) }) }; };
const callback = (params) => run(`bootFromRequest_(${JSON.stringify(params)})`);

// --- Attacks / failures
respond(good('shivakumarullagaddi56@gmail.com'));
let b = callback({ code: 'c1', state: 'f'.repeat(64) });
assert.ok(b.authError && !b.session); console.log('  ✓ refused forged state →', b.authError);
b = callback({ error: 'access_denied', state });
assert.ok(b.authError); console.log('  ✓ user cancelled →', b.authError);
const fresh = () => new URL(run("apiBootstrap('')").data.loginUrl).searchParams.get('state');
respond(Object.assign(good('x@gmail.com'), { aud: 'other-app' }));
b = callback({ code: 'c2', state: fresh() }); assert.ok(b.authError); console.log('  ✓ token for another app →', b.authError);
respond(Object.assign(good('x@gmail.com'), { email_verified: false }));
b = callback({ code: 'c3', state: fresh() }); assert.ok(b.authError); console.log('  ✓ unverified email →', b.authError);
respond(Object.assign(good('x@gmail.com'), { exp: 1 }));
b = callback({ code: 'c4', state: fresh() }); assert.ok(b.authError); console.log('  ✓ expired token →', b.authError);
env.tokenResponse = { code: 400, body: '{"error":"invalid_grant"}' };
b = callback({ code: 'bad', state: fresh() }); assert.ok(b.authError); console.log('  ✓ bad code →', b.authError);

// --- Happy path: Test Lead (a Gmail account) signs in and lands where they started
respond(good('ShivakumarUllagaddi56@gmail.com'));
b = callback({ code: 'c5', state });
assert.ok(/^[a-f0-9]{64}$/.test(b.session));
assert.strictEqual(b.view, 'approvals'); assert.strictEqual(b.req, 'LR-2026-0012'); assert.ok(b.cleanUrl);
const sent = env.tokenRequests.at(-1);
assert.strictEqual(sent.client_secret, 's3cret'); assert.strictEqual(sent.redirect_uri, 'https://script.google.com/macros/s/LIVE/exec');
assert.strictEqual(callback({ code: 'c5', state }).authError !== undefined, true, 'state is single-use');
const lead = b.session;
boot = run(`apiBootstrap('${lead}')`).data;
assert.strictEqual(boot.me.name, 'Test Lead');
assert.strictEqual(boot.identity.isAdmin, false);
assert.strictEqual(boot.people.length, 0, 'non-admin gets no View-as list');
console.log('✓ Gmail test lead signed in →', boot.me.name, '·', boot.me.team_name, '· returned to', b.view, b.req);

// --- Employee signs in, applies; lead approves with their own session
respond(good('shivakumar.u@darukaa.com'));
const emp = callback({ code: 'c6', state: fresh() }).session;
boot = run(`apiBootstrap('${emp}')`).data;
assert.strictEqual(boot.me.name, 'Test Employee'); assert.ok(boot.identity.isAdmin);
const r = run(`apiSubmit('${emp}', {type_id:'LT-PL',start_date:'2026-11-26',end_date:'2026-11-27',reason:'Sign-in test'})`).data;
assert.strictEqual(r.status, 'PENDING');
assert.strictEqual(run(`apiDecide('${emp}', '${r.req_id}', 'APPROVED', '')`).code, 'FORBIDDEN', 'employee cannot approve own request');
const d = run(`apiDecide('${lead}', '${r.req_id}', 'APPROVED', 'ok')`).data;
assert.strictEqual(d.status, 'APPROVED'); assert.strictEqual(d.final_by, 'E902');
console.log('✓ employee applied with own session; lead approved with own session →', d.status, 'by', d.final_by_name);

respond(good('shivakumarullagaddi855@gmail.com'));
const cxo = callback({ code: 'c7', state: fresh() }).session;
const d2 = run(`apiDecide('${cxo}', '${r.req_id}', 'APPROVED', '')`).data;
console.log('✓ CXO added approval:', d2.approvals.map((a) => a.name + ' ' + a.decision).join(', '));

// --- Unknown Google account, session expiry, sign-out
respond(good('stranger@gmail.com'));
const stranger = callback({ code: 'c8', state: fresh() }).session;
boot = run(`apiBootstrap('${stranger}')`).data;
assert.strictEqual(boot.me, null); assert.strictEqual(boot.identity.email, 'stranger@gmail.com');
assert.strictEqual(run(`apiSubmit('${stranger}', {})`).code, 'NOT_REGISTERED');
console.log('✓ unknown Google account signs in but sees "not set up" and can do nothing');

run(`apiSignOut('${lead}')`);
assert.strictEqual(run(`apiPreview('${lead}', {})`).code, 'UNAUTHENTICATED');
assert.ok(run(`apiBootstrap('${lead}')`).data.loginUrl);
assert.strictEqual(run(`apiPreview('not-a-token', {})`).code, 'UNAUTHENTICATED');
env.today = '2026-11-03T11:30:00Z'; // +6.5 h
assert.strictEqual(run(`apiPreview('${emp}', {})`).code, 'UNAUTHENTICATED');
console.log('✓ sign-out ends the session; garbage tokens refused; sessions expire after 6 h');
console.log('\nAUTH TESTS PASSED');
