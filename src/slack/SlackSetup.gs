/**
 * SlackSetup.gs — run from the Apps Script editor.
 *   setupSlack()  installs the once-a-minute background trigger, warms the cache, then checks everything.
 *   checkSlack()  tells you, in one list, what the Leave app in Slack still needs.
 */
function setupSlack() {
  SlackJobs.install();
  SlackDaily.install();
  SlackCache.refresh();
  return checkSlack();
}

/**
 * One-off clean-up: earlier versions wrote Slack member IDs into Employees.slack_user_id. Clears the ones
 * Leave Desk wrote itself (AuditLog actor "slack"); IDs typed in by an admin are kept. The links keep
 * working from the cache. Prints only a count.
 */
function forgetSlackIds() {
  Db.refresh();
  const written = {};
  Db.table('AuditLog').where((l) => l.actor === 'slack' && l.entity === 'Employees' && l.field === 'slack_user_id')
    .forEach((l) => { written[l.entity_id] = l.new_value; });
  let cleared = 0;
  Db.table('Employees').all().forEach((e) => {
    if (e.slack_user_id && written[e.emp_id] === e.slack_user_id) {
      Db.table('Employees').update(e.emp_id, { slack_user_id: '', updated_at: DateUtil.now() });
      cleared++;
    }
  });
  SlackCache.refresh();
  const text = 'Cleared ' + cleared + ' Slack ID' + (cleared === 1 ? '' : 's') + ' that Leave Desk had written to Employees. People are still found on Slack by email (kept in the cache only).';
  SetupUi.notify('Slack IDs', text);
  return cleared;
}

function checkSlack() {
  const NEEDED = ['commands', 'users:read', 'users:read.email', 'chat:write', 'im:write'];
  const lines = [];
  const mark = (good, text) => lines.push((good ? '✔ ' : '✘ ') + text);

  const token = SlackBot.prop('SLACK_BOT_TOKEN');
  mark(/^xoxb-/.test(token), 'SLACK_BOT_TOKEN ' + (!token ? 'missing → OAuth & Permissions → Bot User OAuth Token → Script Properties'
    : /^xoxb-/.test(token) ? 'set (xoxb-…)' : 'set but not a bot token (must start with xoxb-)'));
  const verify = SlackBot.prop('SLACK_VERIFICATION_TOKEN');
  mark(!!verify, 'SLACK_VERIFICATION_TOKEN ' + (verify ? 'set' : 'missing → Basic Information → Verification Token (without it anyone with the URL can call the bot)'));
  const appUrl = SlackBot.prop('APP_URL');
  mark(/\/exec$/.test(appUrl), 'APP_URL (Script Property) ' + (appUrl || 'empty') +
    ' → the Request URL in Slash Commands, Interactivity & Shortcuts (On) and Event Subscriptions (On, bot event app_home_opened)');
  const installed = SlackJobs.isInstalled();
  mark(installed, 'Background trigger ' + (installed ? 'installed (every minute)' : 'missing → run setupSlack once and allow the permission'));
  const watching = SlackJobs.isWatching();
  mark(watching, 'Sheet edits ' + (watching ? 'reach Slack automatically within a minute (no need to run setupSlack again)' : 'are not watched → run setupSlack once and allow the permission'));
  const lastRun = Number(SlackBot.prop('SLACK_LAST_RUN') || 0);
  const ago = lastRun ? Math.round((Date.now() - lastRun) / 60000) : -1;
  mark(ago >= 0 && ago <= 3, 'Background trigger last ran ' + (ago < 0 ? 'never' : ago + ' min ago') + (ago > 3 ? ' → check Triggers page for failures' : ''));
  const dailyChannel = SlackDaily.channel();
  const dailyOn = !!dailyChannel && SlackDaily.isInstalled();
  mark(dailyOn, 'Daily leave post ' + (!dailyChannel ? 'OFF → put a channel ID in Settings → SLACK_DAILY_CHANNEL'
    : dailyOn ? 'every working day at ' + SlackDaily.time().label + ' to ' + dailyChannel + ' (invite the bot there: /invite @Leave app; test with postDailyLeaveNow)'
      : 'trigger missing or time changed → run setupSlack again'));
  const notify = Config.bool('SLACK_ENABLED');
  mark(notify, 'Approver notifications by Slack DM ' + (notify ? 'ON' : 'OFF → set SLACK_ENABLED to TRUE in the Settings tab (email is used meanwhile)'));

  if (token) {
    try {
      const who = SlackBot.authTest();
      mark(true, 'Token works: workspace "' + who.team + '", bot user ' + who.user);
      const missing = NEEDED.filter((s) => who.scopes.indexOf(s) === -1);
      mark(!missing.length, missing.length
        ? 'Scopes missing: ' + missing.join(', ') + ' → OAuth & Permissions → Bot Token Scopes, then "Reinstall to workspace" and copy the token again'
        : 'Scopes: ' + NEEDED.join(', '));
      const me = SetupUi.user();
      try {
        SlackBot.lookupByEmail(me);   // throws if this email is not on Slack; the member ID itself is never printed
        const emp = Directory.byEmail(me);
        mark(!!emp, me + ' is on Slack' + (emp ? ' and is ' + emp.name + ' in Employees' : ' but is NOT in the Employees tab'));
      } catch (e) {
        mark(false, me + ' → ' + e.message + ' (same email on Slack and in Employees?)');
      }
    } catch (e) {
      mark(false, 'Token rejected → ' + e.message);
    }
  }
  lines.push('• App Home: Slack app settings → App Home → Home Tab ON and "Allow users to send Slash commands and messages from the messages tab".');
  lines.push('• Slash Commands: /leavedesk (usage hint "[balance | requests | help]"); optional shortcuts /leave-balance and /leave-requests, all with the same Request URL.');
  lines.push(lines.some((l) => l.charAt(0) === '✘') ? 'Fix the ✘ lines, then type /leavedesk in Slack.' : 'Slack is ON. Type /leavedesk in Slack, or open the Leave app → Home.');
  SetupUi.notify('Slack setup', lines.join('\n'));
  return lines;
}
