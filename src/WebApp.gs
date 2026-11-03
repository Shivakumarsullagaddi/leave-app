/**
 * WebApp.gs — serves the Leave App page and lets HTML files include each other.
 *
 * Deep links from Slack/email: <APP_URL>?view=approvals&req=LR-2026-0012
 * Google sign-in returns here with ?code=…&state=…, which becomes a session.
 */
const WEB_VIEWS = ['overview', 'apply', 'requests', 'approvals'];

function doGet(e) {
  const page = HtmlService.createTemplateFromFile('ui/Index');
  page.boot = toSafeJson_(bootFromRequest_((e && e.parameter) || {}));
  return page.evaluate()
    .setTitle('Leave Desk')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
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
