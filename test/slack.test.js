// Slack entrance: slash command, apply modal, requester card, approve/reject, App Home. Run: node test/slack.test.js
const assert = require('assert');
const { load } = require('./load');

const P = load({ user: '', now: '2026-11-16T05:00:00Z' });   // a Monday
const { env, run, props } = P;
run('setupDatabase()'); run('setupDemo()'); env.webapp = true; run('Db.refresh()');
props.SLACK_BOT_TOKEN = 'xoxb-test';
props.SLACK_VERIFICATION_TOKEN = 'verify-me';
props.APP_URL = 'https://script.google.com/macros/s/TEST/exec';
run("Db.table('Settings').update('SLACK_ENABLED', { value: 'TRUE' })");

// Slack's directory: U-EMP = Test Employee (E903), U-LEAD = Test Lead (E902), U-CXO = Test CXO (E901)
const SLACK = { 'U-EMP': 'shivakumar.u@darukaa.com', 'U-LEAD': 'shivakumarullagaddi56@gmail.com', 'U-CXO': 'shivakumarullagaddi855@gmail.com' };
env.slackReply = (method, p) => {
  if (method === 'users.info') return SLACK[p.user] ? { ok: true, user: { profile: { email: SLACK[p.user] } } } : { ok: false, error: 'user_not_found' };
  if (method === 'users.lookupByEmail') { const id = Object.keys(SLACK).find((k) => SLACK[k] === p.email); return id ? { ok: true, user: { id } } : { ok: false, error: 'users_not_found' }; }
  if (method === 'auth.test') return { ok: true, team: 'Darukaa ESG', user: 'leave_app' };
  return null;
};

const post = (parameter, body) => run(`doPost(${JSON.stringify({ parameter, postData: body ? { contents: body } : undefined })})`).getContent();
const asJson = (s) => JSON.parse(s);
const slash = (text, user, extra) => post(Object.assign({ token: 'verify-me', command: '/leavedesk', text, user_id: user || 'U-EMP', trigger_id: 'trig-1' }, extra || {}));
const interact = (payload) => post({ payload: JSON.stringify(Object.assign({ token: 'verify-me' }, payload)) });
const calls = (method) => env.slack.filter((c) => c.method === method);
const last = (method) => calls(method).at(-1);
const flat = (blocks) => JSON.stringify(blocks);
const requestsOf = (emp) => run(`Db.refresh(); Db.table('LeaveRequests').where((r) => r.emp_id === '${emp}')`);

// ---- raw form bodies are never parsed as JSON (the original bug)
assert.deepStrictEqual(asJson(post({}, 'token=abc&command=%2Fleavedesk')), { ok: false, error: 'Not found' });
console.log('✓ unknown form body is answered, not thrown');

// ---- setupSlack: installs the minute trigger once, warms the cache
run('setupSlack()'); run('setupSlack()');
assert.strictEqual(env.triggers.filter((t) => t.kind === 'minute').length, 1);
assert.ok(env.cache['slack:emp:E903'], 'snapshot warmed for E903');
console.log('✓ setupSlack installs the trigger once and warms', Object.keys(env.cache).filter((k) => k.startsWith('slack:emp:')).length, 'snapshots');

// ---- first contact: Slack user → email → Employees; link job queued; modal opens with balance
let out = slash('');
assert.strictEqual(out, '', 'slash reply must be empty when a modal opens');
let view = last('views.open').payload.view;
assert.strictEqual(view.callback_id, 'leave_apply'); assert.strictEqual(view.private_metadata, 'E903');
assert.ok(/\*Paid \/ Casual Leave\*\\n20 of 20 days left/.test(flat(view.blocks)), 'balance in modal');
assert.deepStrictEqual(view.blocks.filter((b) => b.type === 'input').map((b) => b.block_id), ['type', 'start', 'end', 'reason']);
assert.strictEqual(env.cache['slack:user:U-EMP'].v, 'E903');
assert.strictEqual(JSON.parse(props.SLACK_JOBS)[0].kind, 'link');
run('slackRunJobs()');
assert.strictEqual(run("Db.refresh(); Db.table('Employees').get('E903').slack_user_id"), 'U-EMP', 'Slack ID written to Employees');
console.log('✓ /leavedesk: first contact links U-EMP → E903 and opens the apply modal with balance');

// ---- later commands: no users.info, no sheet read needed
const before = env.slack.length;
out = asJson(slash('balance', 'U-EMP', { channel_id: 'C-GENERAL', channel_name: 'general' }));
assert.strictEqual(out.response_type, 'ephemeral', 'private reply inside a channel');
assert.ok(/Leave balance · 2026/.test(flat(out.blocks)) && /Test Employee · Employee · Test Team/.test(flat(out.blocks)), flat(out.blocks));
assert.ok(/\*Sick Leave\*\\n`██████████`  \*12 of 12\* days left/.test(flat(out.blocks)), flat(out.blocks));
assert.ok(/`\/leavedesk balance` · asked by <@U-EMP>/.test(flat(out.blocks)), 'the command is echoed so the request stays visible');
assert.ok(flat(out.blocks).indexOf('"action_id":"apply"') !== -1, 'Request leave button on the balance card');
out = asJson(slash('requests', 'U-EMP', { channel_id: 'C-GENERAL' }));
assert.ok(/No requests this year yet/.test(flat(out.blocks)));
out = asJson(slash('party', 'U-EMP', { channel_id: 'C-GENERAL' }));
assert.ok(/I don’t know `party`/.test(flat(out.blocks)) && /\*\/leavedesk balance\*/.test(flat(out.blocks)), 'help shown for unknown action');
assert.ok(!env.slack.slice(before).some((c) => c.method === 'users.info'), 'linked person is never looked up again');
console.log('✓ /leavedesk balance · requests · help answer from the cache; replies in a channel are private and echo the command');

// ---- inside the Leave app DM the reply is in_channel, so Slack keeps the typed command above the answer
out = asJson(slash('balance', 'U-EMP', { channel_id: 'D-U-EMP', channel_name: 'directmessage' }));
assert.strictEqual(out.response_type, 'in_channel');
assert.ok(!/asked by/.test(flat(out.blocks)), 'no echo line needed: Slack shows the command itself');
assert.strictEqual(env.cache['slack:dm:U-EMP'].v, 'D-U-EMP', 'DM channel remembered');
out = asJson(slash('balance', 'U-EMP', { channel_id: 'D-SOMEONE-ELSE', channel_name: 'directmessage' }));
assert.strictEqual(out.response_type, 'ephemeral', 'a DM with another person is not the app DM');
// dedicated commands route by their name, whatever the text
out = asJson(slash('', 'U-EMP', { command: '/leave-balance', channel_id: 'D-U-EMP' }));
assert.strictEqual(out.response_type, 'in_channel'); assert.ok(/Leave balance · 2026/.test(flat(out.blocks)));
out = asJson(slash('anything', 'U-EMP', { command: '/leave-requests', channel_id: 'C-GENERAL' }));
assert.ok(/Your leave requests · 2026/.test(flat(out.blocks)) && /`\/leave-requests anything`/.test(flat(out.blocks)));
out = asJson(slash('bal', 'U-EMP', { channel_id: 'C-GENERAL' }));
assert.ok(/Leave balance · 2026/.test(flat(out.blocks)), 'short alias');
assert.ok(/token \d+ms · snapshot\(cache\) \d+ms · where \d+ms/.test(run('SlackHandler.timing()')), run('SlackHandler.timing()'));
console.log('✓ in_channel inside the app DM; /leave-balance and /leave-requests work as their own commands; phases timed:', run('SlackHandler.timing()'));

// ---- refused: forged token, stranger
out = asJson(slash('', 'U-EMP', { token: 'forged' }));
assert.ok(/did not come from the Leave app/.test(out.text), out.text);
out = asJson(slash('', 'U-NOBODY'));
assert.ok(/Slack said "user_not_found"/.test(out.text), out.text);
console.log('✓ refused: forged token, unknown Slack user');

// ---- Send request: card posted at once, nothing filed yet; the job files it and updates the card
const submission = (start, end, user, extra) => interact({
  type: 'view_submission', user: { id: user || 'U-EMP', name: 'shiva' },
  view: Object.assign({ callback_id: 'leave_apply', private_metadata: 'E903', state: { values: {
    type: { v: { selected_option: { value: 'LT-PL', text: { type: 'plain_text', text: 'Paid / Casual Leave' } } } },
    start: { v: { selected_date: start } }, end: { v: { selected_date: end } }, reason: { v: { value: 'Family trip' } },
  } } }, extra || {}),
});
out = asJson(submission('2026-11-18', '2026-11-19'));
assert.deepStrictEqual(out, { response_action: 'clear' });
let card = last('chat.postMessage');
assert.strictEqual(card.payload.channel, 'U-EMP');
assert.ok(/Your leave request/.test(flat(card.payload.blocks)) && /Sending to Leave Desk…/.test(flat(card.payload.blocks)) && /Family trip/.test(flat(card.payload.blocks)), flat(card.payload.blocks));
assert.ok(/\*Requested by\*\\nTest Employee · Employee · Test Team/.test(flat(card.payload.blocks)) && /\*Working days\*\\nCounting…/.test(flat(card.payload.blocks)), flat(card.payload.blocks));
assert.strictEqual(requestsOf('E903').length, 0, 'nothing filed before the job runs');
assert.ok(env.triggers.some((t) => t.kind === 'once'), 'one-off kick created');
assert.strictEqual(run('slackRunJobs()'), 1);
assert.strictEqual(env.triggers.filter((t) => t.kind === 'once').length, 0, 'kicks cleared');
const req = requestsOf('E903')[0];
assert.ok(req && req.status === 'PENDING' && req.days === 2 && req.reason === 'Family trip', JSON.stringify(req));
let upd = last('chat.update');
assert.strictEqual(upd.payload.channel, 'D-U-EMP', 'update targets the DM channel Slack answered with'); assert.ok(upd.payload.ts, 'update has a ts');
const filed = flat(upd.payload.blocks);
assert.ok(new RegExp(req.req_id).test(filed) && /Waiting for Test Lead or Test CXO — either one is enough/.test(filed), filed);
assert.ok(/⏳ \*Test Lead\* · Team Lead · waiting\\n⏳ \*Test CXO\* · C-suite · waiting/.test(filed) && /\*Working days\*\\n2 days/.test(filed), filed);
assert.ok(/Either approval is enough/.test(filed) && /approvers have been told/.test(filed) && /sent 2026-11-16/.test(filed), filed);
const approverCards = calls('chat.postMessage').filter((c) => c.payload.channel === 'U-LEAD' || c.payload.channel === 'U-CXO');
assert.strictEqual(approverCards.length, 2, 'lead and CXO each get a card');
assert.ok(approverCards.every((c) => /your decision needed/.test(flat(c.payload.blocks)) && /"action_id":"approve"/.test(flat(c.payload.blocks))), 'approver cards have buttons');
const leadText = flat(approverCards.find((c) => c.payload.channel === 'U-LEAD').payload.blocks);
assert.ok(/\*Requested by\*\\nTest Employee · Test Team/.test(leadText) && /\*Approvers\*\\n⏳ Test Lead \(Team Lead\)\\n⏳ Test CXO \(C-suite\)/.test(leadText), leadText);
assert.ok(/Your decision is needed/.test(leadText) && /\*Status\*\\n⏳ Waiting for Test Lead and Test CXO/.test(leadText), leadText);
console.log('✓ Send request → card at once → filed as', req.req_id, '→ card updated; lead + CXO got Approve/Reject cards');

// ---- bad input stays in the modal; overlap is reported on the card, nothing saved
out = asJson(submission('2026-11-25', '2026-11-24'));
assert.strictEqual(out.response_action, 'errors'); assert.ok(/end date is before the start date/.test(out.errors.start));
asJson(submission('2026-11-19', '2026-11-19'));
run('slackRunJobs()');
upd = last('chat.update');
assert.ok(/Not filed/.test(flat(upd.payload.blocks)) && /already have leave on some of these dates/.test(flat(upd.payload.blocks)), flat(upd.payload.blocks));
assert.strictEqual(requestsOf('E903').length, 1);
console.log('✓ bad range stays in the modal; overlap shows on the card as Not filed');

// ---- Approve from Slack: button → comment modal → job → decision recorded → approver card updated, requester told
const leadCard = approverCards.find((c) => c.payload.channel === 'U-LEAD');
const approveBtn = leadCard.payload.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === 'approve');
out = interact({ type: 'block_actions', user: { id: 'U-LEAD' }, trigger_id: 'trig-2', actions: [approveBtn],
  container: { type: 'message', channel_id: 'D-LEAD', message_ts: leadCard.payload.ts || 'ts-lead' } });
assert.strictEqual(out, '');
view = last('views.open').payload.view;
assert.strictEqual(view.callback_id, 'leave_decide');
const meta = JSON.parse(view.private_metadata);
assert.strictEqual(meta.req_id, req.req_id); assert.strictEqual(meta.decision, 'APPROVED'); assert.strictEqual(meta.channel, 'D-LEAD');
assert.ok(/\*Requested by\*\\nTest Employee/.test(flat(view.blocks)) && /Wed 18 Nov/.test(flat(view.blocks)) && /\*Leave type\*\\nPaid \/ Casual Leave/.test(flat(view.blocks)) &&
  /\*Working days\*\\n2 days/.test(flat(view.blocks)), flat(view.blocks));
const decide = (m, comment, user) => interact({ type: 'view_submission', user: { id: user }, view: { callback_id: 'leave_decide', private_metadata: JSON.stringify(m),
  state: { values: { comment: { v: { value: comment } } } } } });
out = asJson(decide(meta, 'Enjoy!', 'U-LEAD'));
assert.deepStrictEqual(out, { response_action: 'clear' });
assert.strictEqual(requestsOf('E903')[0].status, 'PENDING', 'not decided until the job runs');
run('slackRunJobs()');
assert.strictEqual(requestsOf('E903')[0].status, 'APPROVED');
upd = last('chat.update');
assert.strictEqual(upd.payload.channel, 'D-LEAD');
assert.ok(/You approved Test Employee’s leave/.test(flat(upd.payload.blocks)) && /Enjoy!/.test(flat(upd.payload.blocks)) &&
  /✅ \*Test Lead\* · Team Lead · approved 2026-11-16/.test(flat(upd.payload.blocks)) && /\*Status\*\\n✅ Approved by Test Lead/.test(flat(upd.payload.blocks)), flat(upd.payload.blocks));
const told = calls('chat.postMessage').filter((c) => c.payload.channel === 'U-EMP').at(-1);
assert.ok(/Leave approved/.test(flat(told.payload.blocks)) || /Approved/.test(flat(told.payload.blocks)), flat(told.payload.blocks));
console.log('✓ Lead approved from Slack with a comment →', req.req_id, 'APPROVED; approver card updated; requester got the ✅ card');

// ---- Reject needs a reason; CXO rejects the approved leave (allowed until it starts)
const rejMeta = Object.assign({}, meta, { decision: 'REJECTED', channel: '', ts: '' });
out = asJson(decide(rejMeta, '', 'U-CXO'));
assert.strictEqual(out.response_action, 'errors'); assert.ok(/Add a short reason/.test(out.errors.comment));
asJson(decide(rejMeta, 'Client visit that week', 'U-CXO'));
run('slackRunJobs()');
assert.strictEqual(requestsOf('E903')[0].status, 'REJECTED');
const cxoNote = calls('chat.postMessage').filter((c) => c.payload.channel === 'U-CXO').at(-1);
assert.ok(/You rejected Test Employee’s leave/.test(flat(cxoNote.payload.blocks)) && /Client visit/.test(flat(cxoNote.payload.blocks)), flat(cxoNote.payload.blocks));
const rejected = calls('chat.postMessage').filter((c) => c.payload.channel === 'U-EMP').at(-1);
assert.ok(/Leave not approved/.test(flat(rejected.payload.blocks)) && /Client visit that week/.test(flat(rejected.payload.blocks)), flat(rejected.payload.blocks));
console.log('✓ CXO rejected with a reason → REJECTED; requester sees the reason');

// ---- a decision that is no longer possible is explained, not swallowed
asJson(decide(meta, '', 'U-LEAD'));
run('slackRunJobs()');
const sorry = calls('chat.postMessage').filter((c) => c.payload.channel === 'U-LEAD').at(-1);
assert.ok(/was not recorded: You have already responded/.test(sorry.payload.text), sorry.payload.text);
console.log('✓ repeat decision →', sorry.payload.text);

// ---- App Home: opened → published from cache; republished after changes; Request leave button opens the modal
out = post({}, JSON.stringify({ type: 'event_callback', token: 'verify-me', event: { type: 'app_home_opened', user: 'U-LEAD', tab: 'home' } }));
assert.strictEqual(out, '');
let home = last('views.publish');
assert.strictEqual(home.payload.user_id, 'U-LEAD'); assert.strictEqual(home.payload.view.type, 'home');
assert.ok(/Hi \*Test Lead\*/.test(flat(home.payload.view.blocks)) && /"action_id":"apply"/.test(flat(home.payload.view.blocks)), flat(home.payload.view.blocks));
assert.deepStrictEqual(JSON.parse(props.SLACK_HOME_USERS), ['U-LEAD']);
// a new request from the employee lands in the lead's Home inbox with buttons
asJson(submission('2026-12-07', '2026-12-08'));
run('slackRunJobs()');
home = last('views.publish');
const homeText = flat(home.payload.view.blocks);
assert.ok(/Waiting for your decision \(1\)/.test(homeText) && /\*Requested by\*\\nTest Employee/.test(homeText) && /Mon 7 Dec → Tue 8 Dec/.test(homeText) && /"action_id":"reject"/.test(homeText), homeText);
assert.ok(/Hi \*Test Lead\* · Team Lead · Test Team · 2026/.test(homeText) && /`██████████`  \*20 of 20\* days left/.test(homeText), homeText);
// the requester's own list shows status + id under each request
const empHome = asJson(slash('requests', 'U-EMP', { channel_id: 'D-U-EMP' }));
assert.ok(/\*Status\*\\n⏳ Waiting for Test Lead or Test CXO — either one is enough/.test(flat(empHome.blocks)) && /\*Status\*\\n❌ Rejected by Test CXO/.test(flat(empHome.blocks)), flat(empHome.blocks));
out = interact({ type: 'block_actions', user: { id: 'U-LEAD' }, trigger_id: 'trig-3', actions: [{ action_id: 'apply', value: 'home' }], container: { type: 'view' } });
assert.strictEqual(last('views.open').payload.view.private_metadata, 'E902', 'lead applies as themselves');
console.log('✓ App Home: balances + inbox + Request leave; republished after the new request');

// ---- Events API handshake
assert.deepStrictEqual(asJson(post({}, JSON.stringify({ type: 'url_verification', token: 'verify-me', challenge: 'c-123' }))), { challenge: 'c-123' });
console.log('✓ url_verification challenge echoed');

// ---- checkSlack(): the editor-side self check
env.user = 'shivakumar.u@darukaa.com';
let lines = run('checkSlack()');
assert.ok(lines.every((l) => l.charAt(0) !== '✘') && /Slack is ON/.test(lines[lines.length - 1]), lines.join('\n'));
console.log('✓ checkSlack all green:\n   ' + lines.join('\n   '));
env.slackScopes = 'commands,chat:write';
delete props.SLACK_VERIFICATION_TOKEN;
lines = run('checkSlack()');
assert.ok(lines.some((l) => /Scopes missing: users:read, users:read.email/.test(l)) && lines.some((l) => /✘ SLACK_VERIFICATION_TOKEN missing/.test(l)), lines.join('\n'));
console.log('✓ checkSlack names missing scopes and token');

// ---- every Slack reply stayed on the fast path: no sheet reads after first contact is a design rule, timing is logged by doPost
console.log('SLACK TESTS PASSED');
