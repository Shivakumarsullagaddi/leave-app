/**
 * WebApp.gs — serves the Leave App page and lets HTML files include each other.
 *
 * Deep links from Slack/email: <APP_URL>?view=approvals&req=LR-2026-0012
 * Google sign-in returns here with ?code=…&state=…, which becomes a session.
 */
const WEB_VIEWS = ['overview', 'apply', 'requests', 'approvals', 'reports', 'admin'];

function doGet(e) {
  const page = HtmlService.createTemplateFromFile('ui/Index');
  page.boot = toSafeJson_(bootFromRequest_((e && e.parameter) || {}));
  return page.evaluate()
    .setTitle('Leave Desk')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Slack posts here: slash commands and modal submissions. Replies are what Slack shows the user. */
function doPost(e) {
  let payload;
  try {
    payload = slackPayload_(e);
  } catch (err) {
    console.error('doPost: unreadable request: ' + (err && err.stack ? err.stack : err));
    return jsonOut_({ response_type: 'ephemeral', text: 'Leave Desk could not read that request.' });
  }
  if (!payload) return jsonOut_({ ok: false, error: 'Not found' });
  const started = Date.now();
  const reply = SlackHandler.handle(payload);
  console.log('Slack ' + payload.type + ' answered in ' + (Date.now() - started) + ' ms (Slack allows 3000): ' + SlackHandler.timing());
  return reply ? jsonOut_(reply) : ContentService.createTextOutput('');
}

/**
 * Slack sends three shapes: slash commands as form fields (command, text, user_id …),
 * interactive events as a form field `payload` holding JSON, and the Events API
 * (url_verification handshake, app_home_opened) as a JSON body.
 */
function slackPayload_(e) {
  const p = (e && e.parameter) || {};
  if (p.payload) return JSON.parse(p.payload);
  if (p.command) {
    return { type: 'slash_command', token: p.token || '', command: p.command, text: p.text || '',
      user_id: p.user_id || '', user_name: p.user_name || '', channel_id: p.channel_id || '', channel_name: p.channel_name || '',
      trigger_id: p.trigger_id || '', response_url: p.response_url || '' };
  }
  const body = String((e && e.postData && e.postData.contents) || '').trim();
  if (body.charAt(0) === '{') {
    const json = JSON.parse(body);
    if (json && (json.type === 'url_verification' || json.type === 'event_callback')) return json;
  }
  return null;
}

function jsonOut_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

/** What the page needs to start: which view, and a fresh session after sign-in. */
function bootFromRequest_(params) {
  const pick = (p) => ({
    view: WEB_VIEWS.indexOf(p.view) !== -1 ? p.view : 'overview',
    req: /^[A-Z0-9-]{1,30}$/.test(p.req || '') ? p.req : '',
  });
  if (!params.code && !params.error) return pick(params);
  try {
    const result = Auth.handleCallback(params);
    return Object.assign(pick(result.returnTo), { session: result.session, cleanUrl: true });
  } catch (err) {
    return { view: 'overview', req: '', authError: err instanceof AppError ? err.message : 'Google sign-in failed.', cleanUrl: true };
  }
}

/** Used inside HTML templates: <?!= include('ui/Styles') ?> */
function include(file) {
  return HtmlService.createHtmlOutputFromFile(file).getContent();
}

/** JSON that is safe to print inside a <script> tag. */
function toSafeJson_(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
