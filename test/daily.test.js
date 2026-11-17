// The 11 AM "who is on leave" Slack post (SlackDaily.gs). Run: node test/daily.test.js
const assert = require('assert');
const { load } = require('./load');

const P = load({ user: 'shivakumar.u@darukaa.com', now: '2026-11-16T05:00:00Z' });   // Monday 10:30 IST
const { env, run, props } = P;
run('setupDatabase()');
run('setupDemo()');
props.SLACK_BOT_TOKEN = 'xoxb-test';
env.slackReply = (m) => (m === 'auth.test' ? { ok: true, team: 'Darukaa ESG', user: 'leave_app' } : null);
run('Db.refresh()');

// Approved leave across today and tomorrow, a half day tomorrow, and a pending one (must not show).
const approve = (emp, type, start, end, half) => run(`(() => {
  const r = LeaveService.submit(Directory.employee('${emp}'), { type_id: '${type}', start_date: '${start}', end_date: '${end}', half_day: ${!!half}, reason: 'x' });
  const lead = r.approvals.find((a) => a.decision === 'PENDING');
  return lead ? ApprovalService.decide(Directory.employee(lead.approver_id), r.req_id, 'APPROVED', '') : r;
})()`);
assert.strictEqual(approve('E010', 'LT-PL', '2026-11-16', '2026-11-17').status, 'APPROVED');   // Tanu, BD Team
assert.strictEqual(approve('E013', 'LT-SL', '2026-11-17', '2026-11-17', true).status, 'APPROVED'); // Utkarsh, Product, half day
assert.strictEqual(approve('E001', 'LT-PL', '2026-11-16', '2026-11-16').status, 'APPROVED');   // Vikram, C-suite (auto)
run(`LeaveService.submit(Directory.employee('E015'), { type_id: 'LT-PL', start_date: '2026-11-16', end_date: '2026-11-16', reason: 'pending' })`);  // Harsh: PENDING

// ---- setupSlack installs one daily trigger at 11:00 IST, and only one
run('setupSlack()'); run('setupSlack()');
const daily = env.triggers.filter((t) => t.fn === 'slackDailyDigest');
assert.strictEqual(daily.length, 1); assert.strictEqual(daily[0].hour, 11); assert.strictEqual(daily[0].tz, 'Asia/Kolkata');
console.log('✓ daily trigger installed once: every day at', daily[0].hour + ':00', daily[0].tz);

// ---- the post
const out = run('slackDailyDigest()');
assert.ok(/^Posted to C0CJK6ELW2Y/.test(out), out);
const msg = env.slack.filter((c) => c.method === 'chat.postMessage').at(-1).payload;
const text = JSON.stringify(msg.blocks);
assert.strictEqual(msg.channel, 'C0CJK6ELW2Y');
assert.ok(/daily update/.test(text) && /\*TODAY\*  ·  Mon 16 Nov/.test(text) && /\*TUESDAY\*  ·  Tue 17 Nov/.test(text), text);
assert.ok(/\*BD Team\*  \(1\)\\n• \*Tanu\* is on leave \(Paid \/ Casual Leave\) from Monday, Nov 16, 2026 through Tuesday, Nov 17, 2026/.test(text), text);
assert.ok(/\*C-Suite\*  \(1\)\\n• \*Vikram\* is on leave \(Paid \/ Casual Leave\) on Monday, Nov 16, 2026/.test(text), text);
assert.ok(/\*Product\*  \(1\)\\n• \*Utkarsh\* is on a half day \(Sick Leave\) on Tuesday, Nov 17, 2026/.test(text), text);
assert.ok(!/Harsh/.test(text), 'pending leave is not listed');
assert.strictEqual(msg.text, 'Daily leave update: 2 on leave today, 2 on Tuesday.');
console.log('✓ posted:', msg.text);

// ---- Friday looks ahead to Monday; nobody → "no scheduled leaves"
env.today = '2026-11-20T05:00:00Z';
run('slackDailyDigest()');
const fri = JSON.stringify(env.slack.filter((c) => c.method === 'chat.postMessage').at(-1).payload.blocks);
assert.ok(/\*MONDAY\*  ·  Mon 23 Nov/.test(fri) && /There are no scheduled leaves on Friday/.test(fri) && /There are no scheduled leaves on Monday/.test(fri), fri);
console.log('✓ Friday looks ahead to Monday; empty days say "There are no scheduled leaves"');

// ---- weekends are skipped by the trigger, but postDailyLeaveNow always posts
env.today = '2026-11-21T05:00:00Z';
const posts = env.slack.filter((c) => c.method === 'chat.postMessage').length;
assert.ok(/^Skipped: 2026-11-21 is a weekend/.test(run('slackDailyDigest()')));
assert.strictEqual(env.slack.filter((c) => c.method === 'chat.postMessage').length, posts);
assert.ok(/^Posted/.test(run('postDailyLeaveNow()')));
console.log('✓ Saturday skipped by the trigger; postDailyLeaveNow posts anyway');

// ---- bot not invited → a clear instruction
env.slackReply = (m) => (m === 'chat.postMessage' ? { ok: false, error: 'not_in_channel' } : null);
assert.throws(() => run('postDailyLeaveNow()'), /\/invite @Leave app/);
env.slackReply = null;
console.log('✓ not_in_channel → "type /invite @Leave app"');

// ---- changing the hour re-installs the trigger; empty channel = off
run("Db.table('Settings').update('SLACK_DAILY_HOUR', { value: '9' })"); run('Db.refresh()'); run('setupSlack()');
assert.deepStrictEqual(env.triggers.filter((t) => t.fn === 'slackDailyDigest').map((t) => t.hour), [9]);
run("Db.table('Settings').update('SLACK_DAILY_CHANNEL', { value: '' })"); run('Db.refresh()');
assert.throws(() => run('postDailyLeaveNow()'), /SLACK_DAILY_CHANNEL is empty/);
console.log('✓ new hour → trigger replaced; empty channel → clear message');
console.log('DAILY TESTS PASSED');
