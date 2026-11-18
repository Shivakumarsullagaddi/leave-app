/**
 * Notifier.gs — delivers a message through the first channel that works.
 *
 * Channels are tried in order (Slack, then email as fallback). A channel is any
 * object with { name, isEnabled(), send(msg) }, so adding Teams/WhatsApp later
 * means writing one more channel and adding it to CHANNELS.
 *
 * When a request is settled (approved, rejected, cancelled), every channel that has a
 * settle(request, actor) hook gets it too, so earlier messages with buttons can be closed.
 *
 * Runs AFTER the data is saved: a failed notification never undoes a request.
 */
const Notifier = (() => {
  const CHANNELS = () => [SlackChannel, EmailChannel];
  const SETTLED = { APPROVED: true, REJECTED: true, CANCELLED: true };

  function deliver(msg) {
    for (const channel of CHANNELS()) {
      if (!channel.isEnabled()) continue;
      try {
        channel.send(msg);
        return channel.name;
      } catch (e) {
        console.error('Notifier: ' + channel.name + ' failed for ' + msg.reqId + ': ' + e.message);
      }
    }
    return null;
  }

  function settle(request, actor) {
    CHANNELS().forEach((channel) => {
      if (!channel.settle) return;
      try { channel.settle(request, actor); } catch (e) { console.error('Notifier: ' + channel.name + ' settle failed for ' + request.req_id + ': ' + e.message); }
    });
  }

  /** @param {string|null} event  @param {{reqId: string, actorId?: string}} ctx */
  function publish(event, ctx) {
    try { SlackCache.markDirty(); } catch (e) { /* Slack not set up */ }
    if (!event) return null;
    let request, actor;
    try {
      request = RequestView.byId(ctx.reqId);
      actor = Directory.profile(Directory.employee(ctx.actorId));
    } catch (e) {
      console.error('Notifier: could not load ' + ctx.reqId + ': ' + (e.stack || e));
      return null;
    }
    let sentWith = null;
    try {
      const msg = Messages.build(event, request, actor);
      sentWith = msg ? deliver(msg) : null;
    } catch (e) {
      console.error('Notifier: could not build ' + event + ' for ' + ctx.reqId + ': ' + (e.stack || e));
    }
    if (SETTLED[event] && request) settle(request, actor || { emp_id: '', name: '' });
    return sentWith;
  }

  return { publish };
})();
