/**
 * SlackDaily.gs — the morning "who is on leave" post, like Vacation Tracker's daily update.
 *
 * Settings tab:
 *   SLACK_DAILY_CHANNEL  channel ID (C…) the Leave app posts to; the bot must be invited (/invite @Leave app)
 *   SLACK_DAILY_TIME     time of day, Asia/Kolkata: "11:00", "10:30", "9:45 AM", "2:15 pm" (default 11:00)
 *
 * setupSlack() installs one daily wake trigger (slackDailyDigest) 30–60 minutes early; it books a
 * one-off trigger (slackDailyDigestPost) for the exact minute. Weekends and Holidays-tab dates are skipped.
 * Only APPROVED leave is listed. Run postDailyLeaveNow() from the editor to test at any time.
 */
const SlackDaily = (() => {
  const TRIGGER = 'slackDailyDigest';
  const KEY = 'SLACK_DAILY_TRIGGER';
  const props = () => PropertiesService.getScriptProperties();
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const md = (t) => ({ type: 'mrkdwn', text: t });
  const section = (t) => ({ type: 'section', text: md(t) });
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayName = (iso) => DAYS[DateUtil.parse(iso).getUTCDay()];
  const fmt = (iso, pattern) => Utilities.formatDate(DateUtil.parse(iso), 'UTC', pattern);
  /** "Monday, Nov 16, 2026" */
  const long = (iso) => { const d = DateUtil.parse(iso); return dayName(iso) + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear(); };

  const channel = () => Config.get('SLACK_DAILY_CHANNEL');
  const POST_TRIGGER = 'slackDailyDigestPost';

  /**
   * SLACK_DAILY_TIME → { h, m, label }. Accepts "11:00", "9:30", "14:15", "11", "10:30 AM", "2:15 pm",
   * and a cell Sheets turned into a time ("1899-12-30 11:00"). Falls back to the old SLACK_DAILY_HOUR, then 11:00.
   */
  function time() {
    const raw = String(Config.get('SLACK_DAILY_TIME') || Config.get('SLACK_DAILY_HOUR') || '11:00').trim().toLowerCase();
    const ampm = (raw.match(/\b(am|pm)\b/) || [])[1];
    const hm = raw.match(/(\d{1,2}):(\d{2})(?!.*\d{1,2}:\d{2})/) || raw.match(/^(\d{1,2})(?:\s*(?:am|pm))?$/) || [null, '11', '00'];
    let h = Number(hm[1]);
    const m = Math.min(59, Number(hm[2] || 0));
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    h = Math.min(23, h);
    const label = ((h % 12) || 12) + ':' + ('0' + m).slice(-2) + (h < 12 ? ' AM' : ' PM');
    return { h: h, m: m, label: label };
  }

  function isWorking(iso, cal) {
    return (cal.weekend || [0, 6]).indexOf(DateUtil.parse(iso).getUTCDay()) === -1 && !(cal.holidays || {})[iso];
  }
  function nextWorking(iso, cal) {
    let d = DateUtil.addDays(iso, 1);
    for (let i = 0; i < 14 && !isWorking(d, cal); i++) d = DateUtil.addDays(d, 1);
    return d;
  }

  /** "**Tanu** is on leave (Paid / Casual Leave) from Monday, Nov 16, 2026 through Tuesday, Nov 17, 2026" */
  function line(r, names, types) {
    const who = '*' + esc(names[r.emp_id] || r.emp_id) + '*';
    const type = esc(types[r.type_id] || r.type_id);
    if (r.half_day) return '• ' + who + ' is on a half day (' + type + ') on ' + long(r.start_date);
    if (r.start_date === r.end_date) return '• ' + who + ' is on leave (' + type + ') on ' + long(r.start_date);
    return '• ' + who + ' is on leave (' + type + ') from ' + long(r.start_date) + ' through ' + long(r.end_date);
  }

  /** Blocks for one day: grouped by team, or "There are no scheduled leaves on Wednesday". */
  function dayBlocks(iso, title, leaves, ctx) {
    const blocks = [section('📅  *' + title + '*  ·  ' + fmt(iso, 'EEE d MMM') + '  📅')];
    const onDay = leaves.filter((r) => r.start_date <= iso && iso <= r.end_date);
    if (!onDay.length) return blocks.concat([section('_There are no scheduled leaves on ' + dayName(iso) + '._')]);
    const byTeam = {};
    onDay.forEach((r) => { const t = ctx.teamOf[r.emp_id] || 'No team'; (byTeam[t] = byTeam[t] || []).push(r); });
    Object.keys(byTeam).sort().forEach((t) => {
      const rows = byTeam[t].sort((a, b) => (ctx.names[a.emp_id] < ctx.names[b.emp_id] ? -1 : 1));
      blocks.push(section('*' + esc(t) + '*  (' + rows.length + ')\n' + rows.map((r) => line(r, ctx.names, ctx.types)).join('\n')));
    });
    return blocks;
  }

  /** The whole message for a given date. */
  function build(today) {
    const cal = Catalog.calendar();
    const next = nextWorking(today, cal);
    const names = {}, teamOf = {}, types = {}, teams = {};
    Db.table('Teams').all().forEach((t) => { teams[t.team_id] = t.team_name; });
    Db.table('Employees').all().forEach((e) => { names[e.emp_id] = e.name; teamOf[e.emp_id] = teams[e.team_id] || ''; });
    Catalog.leaveTypes().forEach((t) => { types[t.type_id] = t.name; });
    const leaves = Db.table('LeaveRequests').where((r) => r.status === 'APPROVED' && DateUtil.overlaps(r.start_date, r.end_date, today, next));
    const ctx = { names: names, teamOf: teamOf, types: types };
    const count = (iso) => leaves.filter((r) => r.start_date <= iso && iso <= r.end_date).length;
    const blocks = [section('It’s time for your daily update! 🌴 Here are the upcoming leaves:'), { type: 'divider' }]
      .concat(dayBlocks(today, 'TODAY', leaves, ctx), [{ type: 'divider' }],
        dayBlocks(next, dayName(next).toUpperCase(), leaves, ctx), [{ type: 'divider' }],
        [{ type: 'context', elements: [md('Only approved leave is listed · ' + esc(LD_CONFIG.APP_NAME))] }]);
    const text = 'Daily leave update: ' + count(today) + ' on leave today, ' + count(next) + ' on ' + dayName(next) + '.';
    return { text: text, blocks: blocks, today: today, next: next };
  }

  /** Posts the update. force = true posts even on a weekend or holiday (for testing). */
  function post(force) {
    const target = channel();
    if (!target) throw Errors.config('SLACK_DAILY_CHANNEL is empty in the Settings tab. Put the channel ID there (starts with C).');
    const today = DateUtil.today();
    if (!force && !isWorking(today, Catalog.calendar())) return 'Skipped: ' + today + ' is a weekend or holiday.';
    if (!force && String(props().getProperty('SLACK_DAILY_LAST') || '').slice(0, 10) === today) return 'Skipped: already posted today.';
    const msg = build(today);
    try {
      SlackBot.postMessage(target, msg.text, msg.blocks);
    } catch (err) {
      if (/not_in_channel|channel_not_found/.test(err.message)) {
        throw Errors.config('The Leave app is not in channel ' + target + '. In Slack, open that channel and type /invite @Leave app, then try again.');
      }
      throw err;
    }
    if (!force) props().setProperty('SLACK_DAILY_LAST', DateUtil.now());   // a manual test post never blocks the scheduled one
    return 'Posted to ' + target + ': ' + msg.text;
  }

  // ------------------------------------------------------------------ trigger
  //
  // Apps Script daily triggers only promise "within ±15 minutes". To post at the exact minute,
  // a daily WAKE trigger fires 30–60 minutes early and books a one-off trigger for the exact time.

  const triggersFor = (fn) => ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === fn);
  const spec = () => { const t = time(); return t.h + ':' + t.m; };
  const saved = () => (props().getProperty(KEY) || '').split('@');
  const isInstalled = () => triggersFor(TRIGGER).some((t) => t.getUniqueId() === saved()[0]) && saved()[1] === spec();

  /** One daily wake trigger for SLACK_DAILY_TIME; replaced when the time changes. Returns true if (re)installed. */
  function install() {
    if (!channel()) return false;
    if (isInstalled()) return false;
    triggersFor(TRIGGER).forEach((t) => ScriptApp.deleteTrigger(t));
    const t = time();
    const wake = Math.max(0, t.h * 60 + t.m - 45);
    const trigger = ScriptApp.newTrigger(TRIGGER).timeBased().everyDays(1)
      .atHour(Math.floor(wake / 60)).nearMinute(wake % 60).inTimezone(LD_CONFIG.TIMEZONE).create();
    props().setProperty(KEY, trigger.getUniqueId() + '@' + spec());
    return true;
  }

  /** Minutes since midnight now, in the app's time zone. */
  const nowMinutes = () => { const hm = DateUtil.now().slice(11, 16).split(':').map(Number); return hm[0] * 60 + hm[1]; };

  /** Wake trigger: book the exact-minute post, or post now if the time is (almost) here. */
  function wake() {
    const t = time();
    const waitMs = (t.h * 60 + t.m - nowMinutes()) * 60000;
    if (waitMs > 60000) {
      ScriptApp.newTrigger(POST_TRIGGER).timeBased().after(waitMs).create();
      return 'Booked the daily post for ' + t.label + ' (in ' + Math.round(waitMs / 60000) + ' min).';
    }
    return post(false);
  }

  /** The one-off post trigger: posts, then removes its own spent one-off triggers. */
  function postBooked() {
    try { return post(false); } finally { triggersFor(POST_TRIGGER).forEach((t) => ScriptApp.deleteTrigger(t)); }
  }

  return { build, post, install, isInstalled, channel, time, wake, postBooked };
})();

/** Daily wake trigger (30–60 min before SLACK_DAILY_TIME): books the exact-time post. */
function slackDailyDigest() {
  try { return SlackDaily.wake(); } catch (err) { console.error('slackDailyDigest: ' + (err && err.message ? err.message : err)); throw err; }
}

/** One-off trigger at exactly SLACK_DAILY_TIME (skips weekends and holidays). */
function slackDailyDigestPost() {
  try { return SlackDaily.postBooked(); } catch (err) { console.error('slackDailyDigestPost: ' + (err && err.message ? err.message : err)); throw err; }
}

/** Run from the Apps Script editor to see the daily update in Slack right now. */
function postDailyLeaveNow() {
  const result = SlackDaily.post(true);
  SetupUi.notify('Daily leave update', result);
  return result;
}
