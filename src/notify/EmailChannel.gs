/**
 * EmailChannel.gs — sends the same message by email (used when Slack is off or fails).
 */
const EmailChannel = (() => {
  const html = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const COLORS = { good: '#2D7A4C', bad: '#B3342B', warn: '#9A620E', info: '#1D6B57' };

  const renderPart = (part) => (typeof part === 'string' ? html(part) : '<b>' + html(part.person.name) + '</b>');
  const plainPart = (part) => (typeof part === 'string' ? part : part.person.name);

  function body(msg) {
    const color = COLORS[msg.tone] || COLORS.info;
    const rows = msg.fields.map((f) =>
      '<tr><td style="padding:4px 12px 4px 0;color:#56675F">' + html(f.label) + '</td><td style="padding:4px 0">' + html(f.value) + '</td></tr>').join('');
    return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#14201B;max-width:560px">' +
      (msg.badge ? '<div style="display:inline-block;background:' + color + ';color:#fff;border-radius:4px;padding:2px 8px;font-size:12px">' + html(msg.badge) + '</div>' : '') +
      '<p style="margin:12px 0">' + msg.parts.map(renderPart).join('') + '</p>' +
      '<table style="border-collapse:collapse;border-left:3px solid ' + color + ';padding-left:10px;margin-left:2px">' + rows + '</table>' +
      (msg.comment ? '<p style="color:#56675F;font-style:italic">' + html(msg.comment) + '</p>' : '') +
      (msg.link ? '<p><a href="' + html(msg.link) + '" style="background:' + color + ';color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Open request</a></p>' : '') +
      '<p style="color:#97A9A1;font-size:12px">' + html(Config.get('APP_NAME', 'Leave Desk')) + ' · ' + html(Config.get('ORG_NAME', '')) + '</p></div>';
  }

  return {
    name: 'email',
    isEnabled: () => Config.bool('EMAIL_FALLBACK'),
    send(msg) {
      const to = msg.recipients.map((r) => r.person.email).filter((e) => /@/.test(e));
      if (!to.length) return;
      MailApp.sendEmail({
        to: to.join(','),
        subject: '[' + Config.get('APP_NAME', 'Leave Desk') + '] ' + msg.subject,
        body: msg.parts.map(plainPart).join('') + '\n\n' + msg.fields.map((f) => f.label + ': ' + f.value).join('\n') +
          (msg.comment ? '\n\n' + msg.comment : '') + (msg.link ? '\n\nOpen: ' + msg.link : ''),
        htmlBody: body(msg),
        name: Config.get('APP_NAME', 'Leave Desk'),
      });
    },
  };
})();
