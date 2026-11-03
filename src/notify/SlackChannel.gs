/**
 * SlackChannel.gs — posts a message to Slack through an Incoming Webhook.
 * The webhook URL is a secret, so it lives in Script Properties (SLACK_WEBHOOK_URL).
 */
const SlackChannel = (() => {
  const webhook = () => PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL') || '';
  const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const EMOJI = { good: ':white_check_mark:', bad: ':x:', warn: ':warning:', info: ':palm_tree:' };

  function renderPart(part) {
    if (typeof part === 'string') return escape(part);
    const p = part.person;
    return p.slack_user_id ? '<@' + p.slack_user_id + '>' : '*' + escape(p.name) + '*';
  }

  function payload(msg) {
    const headline = (EMOJI[msg.tone] || '') + ' ' + (msg.badge ? '*' + escape(msg.badge) + '* · ' : '') + msg.parts.map(renderPart).join('');
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: headline } },
      { type: 'section', fields: msg.fields.map((f) => ({ type: 'mrkdwn', text: '*' + escape(f.label) + '*\n' + escape(f.value) })) },
    ];
    if (msg.comment) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_' + escape(msg.comment) + '_' }] });
    if (msg.link) {
      blocks.push({ type: 'actions', elements: [{ type: 'button', style: 'primary', url: msg.link,
        text: { type: 'plain_text', text: 'Open request' } }] });
    }
    return { text: msg.subject, blocks: blocks };
  }

  return {
    name: 'slack',
    isEnabled: () => Config.bool('SLACK_ENABLED') && !!webhook(),
    send(msg) {
      const res = UrlFetchApp.fetch(webhook(), {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(payload(msg)), muteHttpExceptions: true,
      });
      if (res.getResponseCode() !== 200) throw new Error('Slack returned ' + res.getResponseCode() + ': ' + res.getContentText());
    },
  };
})();
