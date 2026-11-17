/**
 * SlackDaily.gs — the morning "who is on leave" post, like Vacation Tracker's daily update.
 *
 * Settings tab:
 *   SLACK_DAILY_CHANNEL  channel ID (C…) the Leave app posts to; the bot must be invited (/invite @Leave app)
 *   SLACK_DAILY_HOUR     hour of the day in the Settings time zone (default 11)
 *
 * setupSlack() installs one daily trigger (slackDailyDigest). Apps Script fires it a few
 * minutes after the hour. Weekends and Holidays-tab dates are skipped.
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
  const hour = () => Math.max(0, Math.min(23, Config.num('SLACK_DAILY_HOUR', 11)));

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
    const appUrl = SlackBot.prop('APP_URL');
    if (appUrl) blocks.splice(blocks.length - 1, 0, { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open Leave Desk' }, url: appUrl, action_id: 'open_link' }] });
    const text = 'Daily leave update: ' + count(today) + ' on leave today, ' + count(next) + ' on ' + dayName(next) + '.';
    return { text: text, blocks: blocks, today: today, next: next };
  }

  /** Posts the update. force = true posts even on a weekend or holiday (for testing). */
  function post(force) {
    const target = channel();
    if (!target) throw Errors.config('SLACK_DAILY_CHANNEL is empty in the Settings tab. Put the channel ID there (starts with C).');
    const today = DateUtil.today();
    if (!force && !isWorking(today, Catalog.calendar())) return 'Skipped: ' + today + ' is a weekend or holiday.';
    const msg = build(today);
    try {
      SlackBot.postMessage(target, msg.text, msg.blocks);
    } catch (err) {
      if (/not_in_channel|channel_not_found/.test(err.message)) {
        throw Errors.config('The Leave app is not in channel ' + target + '. In Slack, open that channel and type /invite @Leave app, then try again.');
      }
      throw err;
    }
    props().setProperty('SLACK_DAILY_LAST', DateUtil.now());
    return 'Posted to ' + target + ': ' + msg.text;
  }

  // ------------------------------------------------------------------ trigger

  const triggers = () => ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === TRIGGER);
  const savedHour = () => Number((props().getProperty(KEY) || '').split('@')[1]);
  const isInstalled = () => triggers().some((t) => t.getUniqueId() === (props().getProperty(KEY) || '').split('@')[0]) && savedHour() === hour();

  /** One daily trigger at SLACK_DAILY_HOUR; replaced if the hour changed. Returns true if (re)installed. */
  function install() {
    if (!channel()) return false;
    if (isInstalled()) return false;
    triggers().forEach((t) => ScriptApp.deleteTrigger(t));
    const t = ScriptApp.newTrigger(TRIGGER).timeBased().everyDays(1).atHour(hour()).nearMinute(0).inTimezone(LD_CONFIG.TIMEZONE).create();
    props().setProperty(KEY, t.getUniqueId() + '@' + hour());
    return true;
  }

  return { build, post, install, isInstalled, channel, hour };
})();

/** Trigger target: every day at SLACK_DAILY_HOUR (skips weekends and holidays). */
function slackDailyDigest() {
  try { return SlackDaily.post(false); } catch (err) { console.error('slackDailyDigest: ' + (err && err.message ? err.message : err)); throw err; }
}

/** Run from the Apps Script editor to see the daily update in Slack right now. */
function postDailyLeaveNow() {
  const result = SlackDaily.post(true);
  SetupUi.notify('Daily leave update', result);
  return result;
}
