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

// ---- SLACK_DAILY_TIME accepts the usual ways of writing a time
const parse = (v) => { run(`Db.table('Settings').update('SLACK_DAILY_TIME', { value: '${v}' }); Db.refresh()`); const t = run('SlackDaily.time()'); return t.h + ':' + t.m + ' ' + t.label; };
assert.strictEqual(parse('10:30'), '10:30 10:30 AM');
assert.strictEqual(parse('9:45 AM'), '9:45 9:45 AM');
assert.strictEqual(parse('2:15 pm'), '14:15 2:15 PM');
assert.strictEqual(parse('11'), '11:0 11:00 AM');
assert.strictEqual(parse('1899-12-30 16:05'), '16:5 4:05 PM', 'a cell Sheets turned into a time');
assert.strictEqual(parse('12:00 am'), '0:0 12:00 AM');
parse('11:00');
console.log('✓ SLACK_DAILY_TIME parses 10:30, 9:45 AM, 2:15 pm, 11, and a Sheets time value');

// ---- setupSlack installs one daily wake trigger 45 min early (fires 30–60 min before), and only one
run('setupSlack()'); run('setupSlack()');
const daily = env.triggers.filter((t) => t.fn === 'slackDailyDigest');
assert.strictEqual(daily.length, 1); assert.strictEqual(daily[0].hour, 10); assert.strictEqual(daily[0].minute, 15); assert.strictEqual(daily[0].tz, 'Asia/Kolkata');
console.log('✓ wake trigger installed once: daily near 10:15 IST for an 11:00 post');

// ---- 10:30 IST: the wake trigger books the exact 11:00 post (30 min later); the booked trigger posts
let out = run('slackDailyDigest()');
assert.ok(/Booked the daily post for 11:00 AM \(in 30 min\)/.test(out), out);
const booked = env.triggers.filter((t) => t.fn === 'slackDailyDigestPost');
assert.strictEqual(booked.length, 1); assert.strictEqual(booked[0].after, 30 * 60000);
assert.strictEqual(env.slack.filter((c) => c.method === 'chat.postMessage').length, 0, 'nothing posted before 11:00');
out = run('slackDailyDigestPost()');
assert.ok(/^Posted to C0CJK6ELW2Y/.test(out), out);
assert.strictEqual(env.triggers.filter((t) => t.fn === 'slackDailyDigestPost').length, 0, 'spent one-off trigger removed');
assert.ok(/already posted today/.test(run('slackDailyDigestPost()')), 'never posts twice on one day');
console.log('✓ 10:30 wake → booked for 11:00 exactly → posted once');
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
env.today = '2026-11-20T05:35:00Z';   // Friday 11:05 IST: the wake ran late, so it posts straight away
assert.ok(/^Posted/.test(run('slackDailyDigest()')));
const fri = JSON.stringify(env.slack.filter((c) => c.method === 'chat.postMessage').at(-1).payload.blocks);
assert.ok(/\*MONDAY\*  ·  Mon 23 Nov/.test(fri) && /There are no scheduled leaves on Friday/.test(fri) && /There are no scheduled leaves on Monday/.test(fri), fri);
console.log('✓ Friday looks ahead to Monday; empty days say "There are no scheduled leaves"');

// ---- weekends are skipped by the trigger, but postDailyLeaveNow always posts
env.today = '2026-11-21T05:35:00Z';
const posts = env.slack.filter((c) => c.method === 'chat.postMessage').length;
assert.ok(/^Skipped: 2026-11-21 is a weekend/.test(run('slackDailyDigestPost()')));
assert.strictEqual(env.slack.filter((c) => c.method === 'chat.postMessage').length, posts);
assert.ok(/^Posted/.test(run('postDailyLeaveNow()')));
console.log('✓ Saturday skipped by the trigger; postDailyLeaveNow posts anyway');

// ---- bot not invited → a clear instruction
env.slackReply = (m) => (m === 'chat.postMessage' ? { ok: false, error: 'not_in_channel' } : null);
assert.throws(() => run('postDailyLeaveNow()'), /\/invite @Leave app/);
env.slackReply = null;
console.log('✓ not_in_channel → "type /invite @Leave app"');

// ---- changing the time re-installs the wake trigger; empty channel = off
run("Db.table('Settings').update('SLACK_DAILY_TIME', { value: '9:30 AM' })"); run('Db.refresh()'); run('setupSlack()');
assert.strictEqual(env.triggers.filter((t) => t.fn === 'slackDailyDigest').map((t) => t.hour + ':' + t.minute).join(), '8:45');
run("Db.table('Settings').update('SLACK_DAILY_CHANNEL', { value: '' })"); run('Db.refresh()');
assert.throws(() => run('postDailyLeaveNow()'), /SLACK_DAILY_CHANNEL is empty/);
console.log('✓ new time → wake trigger replaced (9:30 AM → wakes near 8:45); empty channel → clear message');
console.log('DAILY TESTS PASSED');
