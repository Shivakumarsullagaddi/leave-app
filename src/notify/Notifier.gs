/**
 * Notifier.gs — delivers a message through the first channel that works.
 *
 * Channels are tried in order (Slack, then email as fallback). A channel is any
 * object with { name, isEnabled(), send(msg) }, so adding Teams/WhatsApp later
 * means writing one more channel and adding it to CHANNELS.
 *
 * Runs AFTER the data is saved: a failed notification never undoes a request.
 */
const Notifier = (() => {
  const CHANNELS = () => [SlackChannel, EmailChannel];

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

  /** @param {string|null} event  @param {{reqId: string, actorId?: string}} ctx */
  function publish(event, ctx) {
    if (!event) return null;
    try {
      const request = RequestView.byId(ctx.reqId);
      const actor = Directory.profile(Directory.employee(ctx.actorId));
      const msg = Messages.build(event, request, actor);
      return msg ? deliver(msg) : null;
    } catch (e) {
      console.error('Notifier: could not build ' + event + ' for ' + ctx.reqId + ': ' + (e.stack || e));
      return null;
    }
  }

  return { publish };
})();
