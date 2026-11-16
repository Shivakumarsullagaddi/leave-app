/**
 * SlackChannel.gs — sends each recipient a direct message from the Leave app bot.
 * Needs SLACK_BOT_TOKEN in Script Properties and Settings.SLACK_ENABLED = TRUE.
 * People are found by the slack_user_id column, else by their email on Slack.
 * Approvers get Approve / Reject buttons on the card (SlackCards.fromMessage).
 */
const SlackChannel = (() => ({
  name: 'slack',
  isEnabled: () => Config.bool('SLACK_ENABLED') && !!SlackBot.prop('SLACK_BOT_TOKEN'),
  send(msg) {
    let delivered = 0;
    msg.recipients.forEach((r) => {
      const p = r.person;
      const id = p.slack_user_id || SlackBot.userIdByEmail(p.email);
      if (!id) { console.error('SlackChannel: ' + p.email + ' is not on Slack'); return; }
      SlackBot.postMessage(id, msg.subject, SlackCards.fromMessage(msg, p.emp_id));
      delivered++;
    });
    if (!delivered) throw new Error('none of the recipients are on Slack');
  },
}))();
