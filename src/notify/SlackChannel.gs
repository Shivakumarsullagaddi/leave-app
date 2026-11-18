/**
 * SlackChannel.gs — sends each recipient a direct message from the Leave app bot.
 * Needs SLACK_BOT_TOKEN in Script Properties and Settings.SLACK_ENABLED = TRUE.
 * People are found by the slack_user_id column, else by their email on Slack.
 * Approvers get Approve / Reject buttons on the card (SlackCards.fromMessage).
 *
 * Where each approver's card was posted is remembered (SlackCache.rememberCards). When the
 * request is settled, settle() rewrites all of them at once without buttons, so every approver
 * sees the same final state and nobody can act on a request that is already decided.
 */
const SlackChannel = (() => ({
  name: 'slack',
  isEnabled: () => Config.bool('SLACK_ENABLED') && !!SlackBot.prop('SLACK_BOT_TOKEN'),

  send(msg) {
    let delivered = 0;
    const cards = [];
    msg.recipients.forEach((r) => {
      const p = r.person;
      const id = p.slack_user_id || SlackBot.userIdByEmail(p.email);
      if (!id) { console.error('SlackChannel: ' + p.email + ' is not on Slack'); return; }
      const sent = SlackBot.postMessage(id, msg.subject, SlackCards.fromMessage(msg, p.emp_id));
      if ((msg.actors || []).indexOf(p.emp_id) !== -1 && sent.channel && sent.ts) cards.push({ emp_id: p.emp_id, channel: sent.channel, ts: sent.ts });
      delivered++;
    });
    if (cards.length) SlackCache.rememberCards(msg.reqId, cards);
    if (!delivered) throw new Error('none of the recipients are on Slack');
  },

  /** The request is final: close every approver card that still has buttons, in one parallel round-trip. */
  settle(request, actor) {
    if (request.status === 'APPROVED' && !DecisionPolicy.firstIsFinal()) return 0;   // LEAVE_START: others may still reject
    const cards = SlackCache.takeCards(request.req_id);   // taken first, so a failure below never repeats the work
    SlackCache.settleClaim(request.req_id, { status: request.status, by: actor.name || '', by_emp: actor.emp_id || '',
      slack_user_id: request.status === 'CANCELLED' ? '' : actor.slack_user_id || '', at: request.final_at || DateUtil.now() });
    if (!cards.length || !SlackBot.prop('SLACK_BOT_TOKEN')) return 0;
    const results = SlackBot.callAll(cards.map((c) => ['chat.update', {
      channel: c.channel, ts: c.ts, text: SlackCards.settledText(request, c.emp_id), blocks: SlackCards.settledCard(request, c.emp_id),
    }]));
    results.forEach((res, i) => { if (res instanceof Error) console.error('SlackChannel: could not close card for ' + cards[i].emp_id + ': ' + res.message); });
    return cards.length;
  },
}))();
