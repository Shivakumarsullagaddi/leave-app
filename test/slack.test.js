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

// Slack's directory: U-EMP = Test Employee (E903), U-LEAD = Test Lead (E902), U-CXO = Test CXO (E901), U-ADM = Leave Admin (E900)
const SLACK = { 'U-EMP': 'shivakumar.u@darukaa.com', 'U-LEAD': 'shivakumarullagaddi56@gmail.com', 'U-CXO': 'shivakumarullagaddi855@gmail.com', 'U-ADM': 'admin@leavedesk.test',
  'U-OUT': 'outsider@darukaa.com' };   // on Slack, but not in Employees
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

// ---- an error reply is a valid ephemeral: text only, never blocks:[null] (Slack: invalid_command_response)
const errReply = asJson(slash('', 'U-EMP', { token: 'wrong-token' }));
assert.strictEqual(errReply.response_type, 'ephemeral');
assert.ok(/did not come from the Leave app/.test(errReply.text), errReply.text);
assert.ok(!('blocks' in errReply) || errReply.blocks.every(Boolean), 'blocks must not contain null: ' + flat(errReply.blocks));
console.log('✓ a slash-command error returns a clean ephemeral (no null blocks)');

// ---- setupSlack: installs the minute trigger once, links everyone to Slack by email (one parallel batch, cache only), warms the cache
run('setupSlack()');
const lookups = calls('users.lookupByEmail').length;
const setupLines = run('setupSlack()');
assert.strictEqual(env.triggers.filter((t) => t.kind === 'minute').length, 1);
assert.ok(env.cache['slack:emp:E903'], 'snapshot warmed for E903');
assert.strictEqual(env.cache['slack:user:U-LEAD'].v, 'E902', 'Slack user → employee is cached for everyone');
assert.strictEqual(env.cache['slack:user:U-EMP'].v, 'E903');
assert.strictEqual(run("Db.refresh(); Db.table('Employees').where((e) => e.slack_user_id).length"), 0, 'no Slack ID is ever written to the sheet');
assert.strictEqual(calls('users.lookupByEmail').length, lookups + 1, 'second run looks nobody up again (hits and misses are remembered); the 1 is checkSlack verifying the signed-in person live');
assert.ok(!/U-[A-Z]/.test(setupLines.join('\n')), 'checkSlack never prints a Slack member ID:\n' + setupLines.join('\n'));
console.log('✓ setupSlack installs the trigger once, links', lookups - 1, 'emails in one batch (cache only, sheet untouched), prints no Slack IDs, warms', Object.keys(env.cache).filter((k) => k.startsWith('slack:emp:')).length, 'snapshots');

// ---- first /leavedesk ever is answered from the cache: no users.info, no sheet, no trigger
const triggersBefore = env.triggers.length;
const callsBefore = env.slack.length;
run('Db.refresh()');   // like a fresh Apps Script execution: nothing loaded yet
const readsBefore = env.sheetReads();
let out = slash('');
assert.strictEqual(out, '', 'slash reply must be empty when a modal opens');
assert.deepStrictEqual(env.slack.slice(callsBefore).map((c) => c.method), ['views.open'], 'one Slack call: the modal itself');
assert.strictEqual(env.sheetReads(), readsBefore, 'no sheet read');
assert.strictEqual(env.triggers.length, triggersBefore, 'no trigger created');
assert.ok(/snapshot\(cache\)/.test(run('SlackHandler.timing()')), run('SlackHandler.timing()'));
let view = last('views.open').payload.view;
assert.strictEqual(view.callback_id, 'leave_apply'); assert.strictEqual(view.private_metadata, 'E903');
assert.ok(/\*Paid \/ Casual Leave\*\\n20 of 20 days left/.test(flat(view.blocks)), 'balance in modal');
assert.deepStrictEqual(view.blocks.filter((b) => b.type === 'input').map((b) => b.block_id), ['type', 'start', 'end', 'reason'], 'no half-day question until a single day is picked');
assert.ok(view.blocks.every((b) => b.block_id !== 'start' || !b.element.initial_date), 'dates start empty (Slack would label today as "Today")');
assert.ok(/Pick the first and last day/.test(flat(view.blocks)), 'summary placeholder');
const whoText = flat(view.blocks.find((b) => b.block_id === 'approvers'));
assert.ok(/\*Who approves\*\\n⏳ \*Test Lead\* · Team Lead\\n⏳ \*Test CXO\* · C-suite\\n⏳ \*Leave Admin\* · Admin\\n_All are asked at the same time. Any one approval is enough._/.test(whoText), whoText);
console.log('✓ /leavedesk: very first command opens the apply modal straight from the cache —', run('SlackHandler.timing()'));

// ---- link evicted but snapshot cached: placed by the cached email directory — users.info + views.open, still no sheet
delete env.cache['slack:user:U-ADM'];
run('Db.refresh()');
let reads = env.sheetReads();
let mark = env.slack.length;
out = slash('', 'U-ADM', { trigger_id: 'trig-link' });
assert.strictEqual(out, '');
assert.deepStrictEqual(env.slack.slice(mark).map((c) => c.method), ['users.info', 'views.open']);
assert.strictEqual(last('views.open').payload.view.private_metadata, 'E900');
assert.strictEqual(env.sheetReads(), reads, 'no sheet read');
console.log('✓ link evicted: email directory in the cache places the person —', run('SlackHandler.timing()'));

// ---- snapshot evicted too: a "Setting up…" modal opens at once and the background job fills it — the request never reads the sheet
delete env.cache['slack:user:U-ADM']; delete env.cache['slack:emp:E900'];
run('Db.refresh()');
reads = env.sheetReads();
out = slash('', 'U-ADM', { trigger_id: 'trig-miss' });
assert.strictEqual(out, '');
const loading = last('views.open').payload.view;
assert.strictEqual(loading.callback_id, 'leave_loading', 'something is on screen immediately');
assert.ok(/turns into the leave form by itself within a minute/.test(flat(loading.blocks)), flat(loading.blocks));
assert.strictEqual(env.sheetReads(), reads, 'no sheet read inside the Slack request (that was the timeout)');
assert.ok(/users\.info \d+ms · views\.open\(loading\) \d+ms · enqueue/.test(run('SlackHandler.timing()')), run('SlackHandler.timing()'));
run('slackRunJobs()');
let filled = last('views.update').payload;
assert.ok(/^V-/.test(filled.view_id), 'views.update targets the opened modal: ' + filled.view_id);
assert.strictEqual(filled.view.callback_id, 'leave_apply'); assert.strictEqual(filled.view.private_metadata, 'E900');
console.log('✓ cache miss: "Setting up…" modal at once, filled with the form by the job — no sheet read, no timeout');

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
// a real Slack member whose email is not in Employees (the screenshot case): answered from the cache —
// one users.info + one views.open, no sheet read, so Slack never adds "operation_timeout"
run('Db.refresh()');
reads = env.sheetReads();
mark = env.slack.length;
out = slash('', 'U-OUT');
assert.strictEqual(out, '', 'no ephemeral error: the explanation is in the modal');
assert.deepStrictEqual(env.slack.slice(mark).map((c) => c.method), ['users.info', 'views.open'], 'message modal opened directly, no loading step');
assert.strictEqual(env.sheetReads(), reads, 'no sheet read');
const outsider = last('views.open').payload.view;
assert.strictEqual(outsider.callback_id, 'leave_message');
assert.ok(/outsider@darukaa\.com is not in the Leave Desk directory\. Ask the admin to add you — if they just did, try again in a minute\./.test(flat(outsider.blocks)), flat(outsider.blocks));
mark = env.slack.length;
slash('', 'U-OUT');
assert.deepStrictEqual(env.slack.slice(mark).map((c) => c.method), ['views.open'], 'second try within two minutes: no users.info either');
// the admin adds them: once the cache is refreshed (next minute, it was marked dirty) the form opens
assert.strictEqual(props.SLACK_DIRTY, '1', 'a stranger marks the cache for refresh');
run("Db.table('Employees').update('E904', { email: 'outsider@darukaa.com' })");
env.today = '2026-11-16T05:03:00Z';   // the two-minute "not registered" memory has expired
run('slackRunJobs()');
slash('', 'U-OUT');
assert.strictEqual(last('views.open').payload.view.callback_id, 'leave_apply', 'added person gets the form');
assert.strictEqual(last('views.open').payload.view.private_metadata, 'E904');
run("Db.table('Employees').update('E904', { email: 'test.intern@leavedesk.test' })"); run('SlackCache.refresh()');
env.today = '2026-11-16T05:00:00Z';
// someone Slack doesn't know at all
out = slash('', 'U-NOBODY');
const nobody = last('views.open').payload.view;
assert.strictEqual(nobody.callback_id, 'leave_message');
assert.ok(/⚠️/.test(flat(nobody.blocks)) && !/user_not_found/.test(flat(nobody.blocks)), flat(nobody.blocks));
// balance for a stranger: a clear ephemeral, never a timeout
out = asJson(slash('balance', 'U-NOBODY'));
assert.strictEqual(out.response_type, 'ephemeral'); assert.ok(/⚠️/.test(out.text), out.text);
console.log('✓ refused: forged token; Slack member not in Employees told in the modal from the cache (no timeout):', JSON.stringify(flat(outsider.blocks).match(/⚠️[^"]*/)[0]));

// ---- Send request: card posted at once, nothing filed yet; the job files it and updates the card
const submission = (start, end, user, extra) => interact({
  type: 'view_submission', user: { id: user || 'U-EMP', name: 'shiva' },
  view: Object.assign({ callback_id: 'leave_apply', private_metadata: 'E903', state: { values: {
    type: { v: { selected_option: { value: 'LT-PL', text: { type: 'plain_text', text: 'Paid / Casual Leave' } } } },
    start: { v: { selected_date: start } }, end: { v: { selected_date: end } }, reason: { v: { value: 'Family trip' } },
  } } }, extra || {}),
});
const sendTriggers = env.triggers.length;
const sendCalls = env.slack.length;
out = asJson(submission('2026-11-18', '2026-11-19'));
assert.deepStrictEqual(out, { response_action: 'clear' });
assert.strictEqual(env.triggers.length, sendTriggers, 'Send creates no trigger (that was the slow part)');
assert.deepStrictEqual(env.slack.slice(sendCalls).map((c) => c.method), ['chat.postMessage'], 'Send makes one Slack call: the requester card');
assert.strictEqual(Object.keys(props).filter((k) => k.indexOf('SLACK_JOB_') === 0).length, 1, 'one job queued, no lock');
const optimistic = flat(asJson(slash('balance', 'U-EMP', { channel_id: 'D-U-EMP' })).blocks);
assert.ok(/\*20 of 20\* days left\\n_2 in requests waiting for approval/.test(optimistic), 'balance shows the 2 days waiting before the job runs: ' + optimistic);
console.log('✓ Send: one Slack call, no trigger, job queued; balance already shows the days waiting —', run('SlackHandler.timing()'));
let card = last('chat.postMessage');
assert.strictEqual(card.payload.channel, 'U-EMP');
const first = flat(card.payload.blocks);
assert.ok(/Your leave request/.test(first) && /Family trip/.test(first) && !/Sending to Leave Desk/.test(first), first);
assert.ok(/\*Requested by\*\\nTest Employee · Employee · Test Team/.test(first) && /\*Working days\*\\n2 days/.test(first), first);
assert.ok(/Waiting for Test Lead, Test CXO or Leave Admin — any one is enough/.test(first) &&
  /⏳ \*Test Lead\* · Team Lead · waiting\\n⏳ \*Test CXO\* · C-suite · waiting\\n⏳ \*Leave Admin\* · Admin · waiting/.test(first), 'the first card already names the approvers: ' + first);
assert.ok(!/Open in Leave Desk/.test(first) && !/approvers have been told/.test(first), first);
assert.strictEqual(requestsOf('E903').length, 0, 'nothing filed before the job runs');
assert.strictEqual(run('slackRunJobs()'), 1);
assert.strictEqual(Object.keys(props).filter((k) => k.indexOf('SLACK_JOB_') === 0).length, 0, 'queue drained');
const req = requestsOf('E903')[0];
assert.ok(req && req.status === 'PENDING' && req.days === 2 && req.reason === 'Family trip', JSON.stringify(req));
let upd = last('chat.update');
assert.strictEqual(upd.payload.channel, 'D-U-EMP', 'update targets the DM channel Slack answered with'); assert.ok(upd.payload.ts, 'update has a ts');
const filed = flat(upd.payload.blocks);
assert.ok(new RegExp(req.req_id).test(filed) && /Waiting for Test Lead, Test CXO or Leave Admin — any one is enough/.test(filed), filed);
assert.ok(/⏳ \*Test Lead\* · Team Lead · waiting\\n⏳ \*Test CXO\* · C-suite · waiting\\n⏳ \*Leave Admin\* · Admin · waiting/.test(filed) && /\*Working days\*\\n2 days/.test(filed), filed);
assert.ok(/Any one approval is enough/.test(filed) && !/approvers have been told/.test(filed) && !/Open in Leave Desk/.test(filed) && /sent 2026-11-16/.test(filed), filed);
// the balance is not cut while the request waits; the pending days are shown separately
const balNow = flat(asJson(slash('balance', 'U-EMP', { channel_id: 'D-U-EMP' })).blocks);
assert.ok(/\*20 of 20\* days left\\n_2 in requests waiting for approval \(not taken off yet\)_/.test(balNow), balNow);
const approverCards = calls('chat.postMessage').filter((c) => ['U-LEAD', 'U-CXO', 'U-ADM'].indexOf(c.payload.channel) !== -1);
assert.strictEqual(approverCards.length, 3, 'lead, CXO and admin each get a card');
assert.ok(approverCards.every((c) => /your decision needed/.test(flat(c.payload.blocks)) && /"action_id":"approve"/.test(flat(c.payload.blocks))), 'approver cards have buttons');
const leadText = flat(approverCards.find((c) => c.payload.channel === 'U-LEAD').payload.blocks);
assert.ok(/\*Requested by\*\\nTest Employee · Test Team/.test(leadText) && /\*Approvers\*\\n⏳ Test Lead \(Team Lead\)\\n⏳ Test CXO \(C-suite\)\\n⏳ Leave Admin \(Admin\)/.test(leadText), leadText);
assert.ok(/Your decision is needed/.test(leadText) && /\*Status\*\\n⏳ Waiting for Test Lead, Test CXO and Leave Admin \(any one is enough\)/.test(leadText), leadText);
console.log('✓ Send request → card at once → filed as', req.req_id, '→ card updated; lead + CXO + admin got Approve/Reject cards');

// ---- bad input stays in the modal, judged from the cache: bad range, overlap, weekend only — nothing posted, nothing queued
const badCalls = env.slack.length;
out = asJson(submission('2026-11-25', '2026-11-24'));
assert.strictEqual(out.response_action, 'errors'); assert.ok(/last day is before the first day/.test(out.errors.end), JSON.stringify(out));
out = asJson(submission('2026-11-19', '2026-11-19'));
assert.strictEqual(out.response_action, 'errors');
assert.ok(new RegExp('already have leave on some of these dates \\(' + req.req_id + '\\)').test(out.errors.end), JSON.stringify(out));
out = asJson(submission('2026-11-21', '2026-11-22'));
assert.ok(/all weekends or holidays/.test(out.errors.end), JSON.stringify(out));
assert.strictEqual(env.slack.length, badCalls, 'no Slack call for a refused form');
assert.strictEqual(requestsOf('E903').length, 1);
// the sheet still has the last word if the cache missed something: a clash is reported on the card as Not filed
run(`Db.refresh(); SlackCache.snapshot('E903') && CacheService.getScriptCache().remove('slack:emp:E903')`);
asJson(submission('2026-11-19', '2026-11-19'));
run('slackRunJobs()');
upd = last('chat.update');
assert.ok(/Not filed/.test(flat(upd.payload.blocks)) && /already have leave on some of these dates/.test(flat(upd.payload.blocks)), flat(upd.payload.blocks));
assert.strictEqual(requestsOf('E903').length, 1);
console.log('✓ bad range, overlap and weekend-only are refused inside the form; the sheet re-checks (Not filed) when the cache had no snapshot');

// ---- picking a date redraws the form with the exact dates, working days and balance left (views.update)
const modalState = (start, end, half) => ({ type: { v: { selected_option: { value: 'LT-PL', text: { type: 'plain_text', text: 'Paid / Casual Leave' } } } },
  start: { v: { selected_date: start } }, end: { v: { selected_date: end } }, half: { v: { selected_options: half ? [{ value: 'half' }] : [] } }, reason: { v: { value: 'Kept' } } });
out = interact({ type: 'block_actions', user: { id: 'U-EMP' }, actions: [{ action_id: 'v', block_id: 'end', selected_date: '2026-12-04' }],
  container: { type: 'view' }, view: { id: 'V1', hash: 'h1', callback_id: 'leave_apply', private_metadata: 'E903', state: { values: modalState('2026-11-30', '2026-12-04', false) } } });
assert.strictEqual(out, '');
let upv = last('views.update');
assert.strictEqual(upv.payload.view_id, 'V1'); assert.strictEqual(upv.payload.hash, 'h1');
const summaryOf = (v) => flat(v.blocks.find((b) => b.block_id === 'summary'));
let summary = summaryOf(upv.payload.view);
assert.ok(/\*Dates\*\\nMon 30 Nov 2026\\nto Fri 4 Dec 2026/.test(summary) && /\*Days you are taking\*\\n5 days/.test(summary) &&
  /\*Paid \/ Casual Leave left now\*\\n20 days of 20\\n_2 days already asked for, waiting for approval_/.test(summary) &&
  /\*Left if approved\*\\n13 days\\n_Nothing is taken off until approval_/.test(summary), summary);
assert.ok(!upv.payload.view.blocks.some((b) => b.block_id === 'half'), 'no half-day question for a range');
assert.strictEqual(upv.payload.view.blocks.find((b) => b.block_id === 'reason').element.initial_value, 'Kept', 'typed reason survives the redraw');
assert.strictEqual(upv.payload.view.blocks.find((b) => b.block_id === 'end').element.initial_date, '2026-12-04');
// weekends inside the range are called out
interact({ type: 'block_actions', user: { id: 'U-EMP' }, actions: [{ action_id: 'v', block_id: 'end' }],
  container: { type: 'view' }, view: { id: 'V1', hash: 'h1b', callback_id: 'leave_apply', private_metadata: 'E903', state: { values: modalState('2026-11-27', '2026-11-30', false) } } });
assert.ok(/\*Days you are taking\*\\n2 days\\n_2 days weekend\/holiday not counted_/.test(summaryOf(last('views.update').payload.view)), summaryOf(last('views.update').payload.view));
// same first and last day: the half-day question appears; ticking it makes it 0.5
interact({ type: 'block_actions', user: { id: 'U-EMP' }, actions: [{ action_id: 'v', block_id: 'end' }],
  container: { type: 'view' }, view: { id: 'V1', hash: 'h2', callback_id: 'leave_apply', private_metadata: 'E903', state: { values: modalState('2026-11-30', '2026-11-30', false) } } });
upv = last('views.update');
assert.ok(/Do you want to take a half day\?/.test(flat(upv.payload.view.blocks.find((b) => b.block_id === 'half'))), 'half-day question for a single day');
assert.ok(/\*Days you are taking\*\\n1 day/.test(summaryOf(upv.payload.view)));
interact({ type: 'block_actions', user: { id: 'U-EMP' }, actions: [{ action_id: 'v', block_id: 'half' }],
  container: { type: 'view' }, view: { id: 'V1', hash: 'h3', callback_id: 'leave_apply', private_metadata: 'E903', state: { values: modalState('2026-11-30', '2026-11-30', true) } } });
upv = last('views.update');
summary = summaryOf(upv.payload.view);
assert.ok(/\*Dates\*\\nMon 30 Nov 2026"/.test(summary) && /Half day \(0\.5\)/.test(summary) && /\*Left if approved\*\\n17\.5 days/.test(summary), summary);
assert.ok(upv.payload.view.blocks.find((b) => b.block_id === 'half').element.initial_options.length === 1, 'tick kept');
// a stale half-day tick is ignored once the dates become a range
assert.strictEqual(run(`SlackCards.applyState(${JSON.stringify(modalState('2026-11-30', '2026-12-01', true))}).half`), false);
// over quota is warned about before Send
interact({ type: 'block_actions', user: { id: 'U-EMP' }, actions: [{ action_id: 'v', block_id: 'start' }],
  container: { type: 'view' }, view: { id: 'V1', hash: 'h4', callback_id: 'leave_apply', private_metadata: 'E903', state: { values: modalState('2026-11-30', '2026-12-31', false) } } });
assert.ok(/\*Left if approved\*\\n0 days/.test(summaryOf(last('views.update').payload.view)) &&
  /beyond your balance will be \*Loss of Pay\*/.test(flat(last('views.update').payload.view.blocks)));
console.log('✓ Apply form: labelled breakdown (dates, days taking, left now, left after); half-day question only for a single day; LOP warned');

// ---- a half-day request is filed as 0.5 with end = start
out = asJson(submission('2026-11-30', '2026-11-30', 'U-EMP', { state: { values: modalState('2026-11-30', '2026-11-30', true) } }));
assert.deepStrictEqual(out, { response_action: 'clear' });
run('slackRunJobs()');
const halfReq = requestsOf('E903').find((r) => r.start_date === '2026-11-30');
assert.ok(halfReq && halfReq.half_day === true && halfReq.days === 0.5 && halfReq.end_date === '2026-11-30', JSON.stringify(halfReq));
assert.ok(/\*Working days\*\\nHalf day/.test(flat(last('chat.update').payload.blocks)), flat(last('chat.update').payload.blocks));
run(`LeaveService.cancel(Directory.employee('E903'), '${halfReq.req_id}')`);
console.log('✓ half day filed as', halfReq.req_id, '= 0.5 day');

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

// ---- every approver sees the same final state: the CXO's and admin's cards lost their buttons when the Lead's approval was filed
const lastUpdateOn = (chan) => calls('chat.update').filter((c) => c.payload.channel === chan).at(-1);
['D-U-CXO', 'D-U-ADM'].forEach((chan) => {
  const t = flat(lastUpdateOn(chan).payload.blocks);
  assert.ok(/Test Employee’s leave was approved/.test(t) && /Test Lead approved it at 2026-11-16/.test(t) && /first decision is final/.test(t), t);
  assert.ok(!/"action_id":"approve"/.test(t) && !/"action_id":"reject"/.test(t), 'no buttons left on ' + chan);
});
assert.ok(!('SLACK_CARDS_' + req.req_id in props), 'card list cleared once closed');
console.log('✓ CXO and admin cards closed in one parallel call: "Test Lead approved it … no action is needed from you", no buttons');

// ---- CXO clicks Reject on a card anyway (e.g. an old copy): told at once on the card, no modal, nothing queued
const cxoCard = approverCards.find((c) => c.payload.channel === 'U-CXO');
const rejectBtn = cxoCard.payload.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === 'reject');
const opensBefore = calls('views.open').length;
out = interact({ type: 'block_actions', user: { id: 'U-CXO' }, trigger_id: 'trig-x', actions: [rejectBtn], container: { type: 'message', channel_id: 'D-CXO', message_ts: 'ts-cxo' } });
assert.strictEqual(out, '');
assert.strictEqual(calls('views.open').length, opensBefore, 'no modal for a decided request');
let cl = last('chat.update');
assert.strictEqual(cl.payload.channel, 'D-CXO');
assert.ok(/Already approved/.test(flat(cl.payload.blocks)) && /\*Test Lead\* approved this at 2026-11-16/.test(flat(cl.payload.blocks)) && !/"action_id"/.test(flat(cl.payload.blocks)), flat(cl.payload.blocks));
// a Reject modal that was already open is refused inside the modal (reason is checked first, as before)
const rejMeta = Object.assign({}, meta, { decision: 'REJECTED', channel: '', ts: '' });
out = asJson(decide(rejMeta, '', 'U-CXO'));
assert.strictEqual(out.response_action, 'errors'); assert.ok(/Add a short reason/.test(out.errors.comment));
out = asJson(decide(rejMeta, 'Client visit that week', 'U-CXO'));
assert.strictEqual(out.response_action, 'errors');
assert.ok(/Test Lead approved this at 2026-11-16 .*first decision is final/.test(out.errors.comment), out.errors.comment);
assert.strictEqual(Object.keys(props).filter((k) => k.indexOf('SLACK_JOB_') === 0).length, 0, 'nothing queued');
assert.strictEqual(requestsOf('E903').find((r) => r.req_id === req.req_id).status, 'APPROVED', 'the approval stands');
console.log('✓ CXO tried to reject after the Lead approved → refused instantly:', JSON.stringify(out.errors.comment));
// the Lead sending again is told it is already done
out = asJson(decide(meta, '', 'U-LEAD'));
assert.ok(/You already approved this/.test(out.errors.comment), JSON.stringify(out));
console.log('✓ repeat decision →', out.errors.comment);

// ---- race: Lead and CXO both decide a new request before the minute job runs → first submit wins, deterministically
asJson(submission('2026-11-25', '2026-11-25'));
run('slackRunJobs()');
const raceReq = requestsOf('E903').find((r) => r.start_date === '2026-11-25');
const raceMeta = { req_id: raceReq.req_id, who: 'Test Employee', when: 'Wed 25 Nov', type: 'Paid / Casual Leave', days: '1 day', channel: '', ts: '' };
out = asJson(decide(Object.assign({}, raceMeta, { decision: 'REJECTED' }), 'Client visit that week', 'U-CXO'));   // CXO first
assert.deepStrictEqual(out, { response_action: 'clear' });
out = asJson(decide(Object.assign({}, raceMeta, { decision: 'APPROVED' }), 'ok', 'U-LEAD'));                     // Lead a moment later
assert.strictEqual(out.response_action, 'errors');
assert.ok(/Test CXO rejected this/.test(out.errors.comment), out.errors.comment);
run('slackRunJobs()');
assert.strictEqual(requestsOf('E903').find((r) => r.req_id === raceReq.req_id).status, 'REJECTED');
const rejected = calls('chat.postMessage').filter((c) => c.payload.channel === 'U-EMP').at(-1);
assert.ok(/Leave not approved/.test(flat(rejected.payload.blocks)) && /Client visit that week/.test(flat(rejected.payload.blocks)), flat(rejected.payload.blocks));
console.log('✓ race: CXO rejected first, Lead told at once "Test CXO rejected this…"; filed REJECTED; requester sees the reason');

// ---- even if both slip past the cache claim (same millisecond), the queue files them in order and the second is told
asJson(submission('2026-11-26', '2026-11-26'));
run('slackRunJobs()');
const r2 = requestsOf('E903').find((r) => r.start_date === '2026-11-26');
const m2 = Object.assign({}, raceMeta, { req_id: r2.req_id, when: 'Thu 26 Nov', decision: 'APPROVED' });
asJson(decide(m2, 'first', 'U-LEAD'));
delete env.cache['slack:claim:' + r2.req_id];                                      // simulate the race window
asJson(decide(Object.assign({}, m2, { decision: 'REJECTED' }), 'second', 'U-CXO'));
run('slackRunJobs()');
assert.strictEqual(requestsOf('E903').find((r) => r.req_id === r2.req_id).status, 'APPROVED', 'first queued decision wins');
const loser = calls('chat.postMessage').filter((c) => c.payload.channel === 'U-CXO').at(-1);
assert.ok(/was not recorded: Already approved by Test Lead at .* The first decision is final/.test(loser.payload.text), loser.payload.text);
console.log('✓ same-millisecond race: queue order decides → APPROVED; CXO told:', loser.payload.text);

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
assert.ok(/\*Status\*\\n⏳ Waiting for Test Lead, Test CXO or Leave Admin — any one is enough/.test(flat(empHome.blocks)) && /\*Status\*\\n❌ Rejected by Test CXO/.test(flat(empHome.blocks)), flat(empHome.blocks));
out = interact({ type: 'block_actions', user: { id: 'U-LEAD' }, trigger_id: 'trig-3', actions: [{ action_id: 'apply', value: 'home' }], container: { type: 'view' } });
assert.strictEqual(last('views.open').payload.view.private_metadata, 'E902', 'lead applies as themselves');
console.log('✓ App Home: balances + inbox + Request leave; republished after the new request');

// ---- the admin approves from Slack: their card has buttons; first approval wins
const decReq = requestsOf('E903').find((r) => r.start_date === '2026-12-07');
const admCard = calls('chat.postMessage').filter((c) => c.payload.channel === 'U-ADM' && new RegExp(decReq.req_id).test(flat(c.payload.blocks))).at(-1);
const admBtn = admCard.payload.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === 'approve');
interact({ type: 'block_actions', user: { id: 'U-ADM' }, trigger_id: 'trig-4', actions: [admBtn], container: { type: 'message', channel_id: 'D-ADM', message_ts: 'ts-adm' } });
asJson(decide(JSON.parse(last('views.open').payload.view.private_metadata), 'Approved by admin', 'U-ADM'));
run('slackRunJobs()');
assert.strictEqual(requestsOf('E903').find((r) => r.req_id === decReq.req_id).status, 'APPROVED');
assert.ok(/You approved Test Employee’s leave/.test(flat(last('chat.update').payload.blocks)) &&
  /✅ \*Leave Admin\* · Admin · approved/.test(flat(last('chat.update').payload.blocks)), flat(last('chat.update').payload.blocks));
assert.ok(/\*Status\*\\n✅ Approved by Leave Admin/.test(flat(asJson(slash('requests', 'U-EMP', { channel_id: 'D-U-EMP' })).blocks)));
console.log('✓ Leave Admin approved', decReq.req_id, 'from Slack');

// ---- moving a Slack ID to another row in the sheet re-points that Slack user on the next refresh
run("Db.table('Employees').update('E903', { slack_user_id: '' }); Db.table('Employees').update('E901', { slack_user_id: 'U-EMP' })");
run('SlackCache.refresh()');
assert.strictEqual(last('views.open') && env.cache['slack:user:U-EMP'].v, 'E901', 'U-EMP now resolves to Test CXO');
run("Db.table('Employees').update('E901', { slack_user_id: '' })");
run('SlackCache.refresh()');
assert.strictEqual(env.cache['slack:user:U-EMP'].v, 'E903', 'cleared rows heal themselves: U-EMP is linked back to E903 by email');
assert.strictEqual(env.cache['slack:user:U-CXO'].v, 'E901', 'and E901 is found by its email again (in the cache)');
assert.strictEqual(run("Db.refresh(); Db.table('Employees').get('E901').slack_user_id"), '', 'still nothing written to the sheet');
// an ID that no row (and no email) claims any more is forgotten, not kept for six hours
run("Db.table('Employees').update('E904', { slack_user_id: 'U-GHOST' })"); run('SlackCache.refresh()');
assert.strictEqual(env.cache['slack:user:U-GHOST'].v, 'E904');
run("Db.table('Employees').update('E904', { slack_user_id: '' })"); run('SlackCache.refresh()');
assert.strictEqual(env.cache['slack:user:U-GHOST'], undefined, 'an ID removed from every row is forgotten');
console.log('✓ sheet edits to slack_user_id take effect on refresh; cleared rows are re-linked by email; dropped IDs are forgotten');

// ---- forgetSlackIds(): clears IDs an older version wrote (AuditLog actor "slack"), keeps one an admin typed in
run(`Db.table('Employees').update('E903', { slack_user_id: 'U-EMP' });
  Audit.log({ actor: 'slack', action: 'UPDATE', entity: 'Employees', entity_id: 'E903', field: 'slack_user_id', new_value: 'U-EMP' });
  Db.table('Employees').update('E902', { slack_user_id: 'U-LEAD' });`);
assert.strictEqual(run('forgetSlackIds()'), 1);
assert.strictEqual(run("Db.refresh(); Db.table('Employees').get('E903').slack_user_id"), '', 'auto-written ID cleared');
assert.strictEqual(run("Db.table('Employees').get('E902').slack_user_id"), 'U-LEAD', 'admin-typed ID kept');
assert.strictEqual(env.cache['slack:user:U-EMP'].v, 'E903', 'still linked, from the cache');
run("Db.table('Employees').update('E902', { slack_user_id: '' })"); run('SlackCache.refresh()');
console.log('✓ forgetSlackIds clears only the IDs Leave Desk wrote; links keep working from the cache');

// ---- an email typed into the sheet by hand reaches Slack by itself: on-change trigger marks it, the next minute's run refreshes
assert.strictEqual(env.triggers.filter((t) => t.kind === 'change').length, 1, 'setupSlack installed one on-change trigger');
run('setupSlack()');
assert.strictEqual(env.triggers.filter((t) => t.kind === 'change').length, 1, 'never twice');
env.today = '2026-11-16T05:05:00Z';
run('SlackCache.refresh()');
run("Db.table('Employees').update('E904', { email: 'outsider@darukaa.com' })");
delete props.DATA_CHANGED_AT; delete props.SLACK_DIRTY;            // as if typed in the sheet by hand: the app itself wrote nothing
delete env.cache['slack:user:U-OUT'];
env.today = '2026-11-16T05:06:00Z';
run('slackRunJobs()');
assert.strictEqual(env.cache['slack:user:U-OUT'], undefined, 'without the trigger nobody would notice for ten minutes');
run('slackSheetChanged()');                                        // what the on-change trigger runs
env.today = '2026-11-16T05:07:00Z';
run('slackRunJobs()');
assert.strictEqual(env.cache['slack:user:U-OUT'].v, 'E904', 'new email linked to Slack within a minute — no setupSlack');
// a change made through Leave Desk (Admin page, jobs, setup) records itself
run('Db.refresh()');
env.today = '2026-11-16T05:07:30Z';                                // the admin edits half a minute after that refresh
run("Db.table('Employees').update('E904', { email: 'test.intern@leavedesk.test' })");
assert.strictEqual(Number(props.DATA_CHANGED_AT), Date.parse('2026-11-16T05:07:30Z'), 'app writes record the change');
env.today = '2026-11-16T05:08:00Z';
run('slackRunJobs()');
assert.strictEqual(env.cache['slack:user:U-OUT'], undefined, 'and the old link is dropped on the next run');
env.today = '2026-11-16T05:00:00Z';
console.log('✓ sheet edits by hand (on-change trigger) and by the Admin page reach Slack within a minute, no setupSlack needed');

// ---- someone who left can't keep applying from an old snapshot
run("Db.table('Employees').update('E904', { status: 'Inactive' })"); run('SlackCache.refresh()');
assert.strictEqual(env.cache['slack:emp:E904'], undefined, 'snapshot of an inactive person removed');
run("Db.table('Employees').update('E904', { status: 'Active' })"); run('SlackCache.refresh()');
console.log('✓ deactivated employee: snapshot dropped on refresh');

// ---- decided in the Sheets dashboard (writes LeaveRequests directly, bypassing Leave Desk) → adopted by the minute job
asJson(submission('2026-12-10', '2026-12-10'));
run('slackRunJobs()');
const dash = requestsOf('E903').find((r) => r.start_date === '2026-12-10');
assert.ok(('SLACK_CARDS_' + dash.req_id) in props, 'approver cards remembered');
const balOf = () => run("Db.refresh(); Db.table('LeaveBalances').find((b) => b.emp_id === 'E903' && b.type_id === 'LT-PL' && Number(b.year) === 2026)");
const balBefore = balOf();
run(`Db.table('LeaveRequests').update('${dash.req_id}', { status: 'APPROVED', final_by: 'admin@leavedesk.test' })`);   // what the dashboard's ✓ does
const dmBefore = calls('chat.postMessage').length;
run('slackRunJobs()');
const after = balOf();
assert.strictEqual(after.used, balBefore.used + 1, 'days moved to used'); assert.strictEqual(after.pending, balBefore.pending - 1, 'and out of pending');
assert.strictEqual(run(`Db.refresh(); JSON.stringify(Db.table('Approvals').where((a) => a.req_id === '${dash.req_id}').map((a) => a.decision))`),
  JSON.stringify(['NO_ACTION', 'NO_ACTION', 'NO_ACTION']), 'approvers closed');
assert.strictEqual(requestsOf('E903').find((r) => r.req_id === dash.req_id).final_by, 'E900', 'final_by normalised to the admin emp_id');
const toldEmp = calls('chat.postMessage').slice(dmBefore).filter((c) => c.payload.channel === 'U-EMP');
assert.strictEqual(toldEmp.length, 1, 'requester told once');
assert.ok(/Approved by/.test(flat(toldEmp[0].payload.blocks)) && /Leave Admin/.test(flat(toldEmp[0].payload.blocks)), flat(toldEmp[0].payload.blocks));
['D-U-LEAD', 'D-U-CXO'].forEach((chan) => assert.ok(/was approved/.test(flat(lastUpdateOn(chan).payload.blocks)) && /Leave Admin approved it/.test(flat(lastUpdateOn(chan).payload.blocks)), chan));
assert.ok(!(('SLACK_CARDS_' + dash.req_id) in props));
assert.ok(run(`Db.refresh(); Db.table('AuditLog').where((l) => l.entity_id === '${dash.req_id}').some((l) => /outside Leave Desk/.test(l.reason))`), 'audit row');
const quiet = calls('chat.postMessage').length;
run('slackRunJobs()');
assert.strictEqual(calls('chat.postMessage').length, quiet, 'adopted once, never again');
console.log('✓ dashboard approval adopted within a minute: approvers closed, balance moved, requester told, cards closed, audited — once');

// ---- Events API handshake
assert.deepStrictEqual(asJson(post({}, JSON.stringify({ type: 'url_verification', token: 'verify-me', challenge: 'c-123' }))), { challenge: 'c-123' });
console.log('✓ url_verification challenge echoed');

// ---- checkSlack(): the editor-side self check
env.user = 'shivakumar.u@darukaa.com';
let lines = run('checkSlack()');
assert.ok(lines.every((l) => l.charAt(0) !== '✘') && /Slack is ON/.test(lines[lines.length - 1]), lines.join('\n'));
assert.ok(lines.some((l) => /shivakumar\.u@darukaa\.com is on Slack and is Test Employee in Employees/.test(l)) && !/U-[A-Z]/.test(lines.join('\n')), 'no Slack member ID printed: ' + lines.join('\n'));
console.log('✓ checkSlack all green:\n   ' + lines.join('\n   '));
env.slackScopes = 'commands,chat:write';
delete props.SLACK_VERIFICATION_TOKEN;
lines = run('checkSlack()');
assert.ok(lines.some((l) => /Scopes missing: users:read, users:read.email/.test(l)) && lines.some((l) => /✘ SLACK_VERIFICATION_TOKEN missing/.test(l)), lines.join('\n'));
console.log('✓ checkSlack names missing scopes and token');

// ---- every Slack reply stayed on the fast path: no sheet reads after first contact is a design rule, timing is logged by doPost
console.log('SLACK TESTS PASSED');
