/**
 * Auth.gs — how people get into the app. Three modes:
 *
 *  PICKER  Script Property LOGIN_MODE=PICKER (prototype). The entrance shows one button
 *          per persona in LD_CONFIG.TEST_ACCOUNTS; clicking one opens a session as that
 *          person. No passwords. Set up by setupDemo().
 *  OAUTH   OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET set: "Sign in with Google" (below).
 *  GOOGLE  Neither: Google's built-in session (Session.getActiveUser).
 *
 * OAuth flow:
 *  1. loginUrl()        → Google sign-in page, with a one-time `state` (CSRF protection).
 *  2. Google redirects back to the web app with ?code=…&state=…
 *  3. handleCallback()  → checks state, swaps the code for an ID token on Google's
 *                          token endpoint, validates it, and opens a session.
 *  4. emailFor(token)   → who owns a session (sessions live in CacheService, max 6 h).
 *
 * Secrets live in Script Properties: OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET.
 * If they're missing, Auth is off and Identity falls back to the Google session.
 */
const Auth = (() => {
  const SESSION_SECONDS = 6 * 60 * 60;   // CacheService maximum
  const STATE_SECONDS = 10 * 60;
  const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

  const cache = () => CacheService.getScriptCache();
  const prop = (k) => PropertiesService.getScriptProperties().getProperty(k) || '';
  const clientId = () => prop('OAUTH_CLIENT_ID');

  /** @returns {'picker'|'oauth'|'google'} */
  function mode() {
    if (prop('LOGIN_MODE').toUpperCase() === 'PICKER') return 'picker';
    if (clientId() && prop('OAUTH_CLIENT_SECRET')) return 'oauth';
    return 'google';
  }
  const isEnabled = () => mode() !== 'google';

  function openSession(email) {
    const session = randomToken();
    cache().put('session:' + session, String(email).toLowerCase(), SESSION_SECONDS);
    return session;
  }

  /** Prototype entrance buttons: persona key + label + who it is. */
  function personas() {
    return LD_CONFIG.TEST_ACCOUNTS.map((t) => {
      const e = Directory.byEmail(t.email);
      return { persona: t.persona, label: t.label, name: e ? e.name : t.name,
        team: e ? (Directory.profile(e).team_name || '') : '', ready: !!e };
    });
  }

  /** Opens a session as the persona's employee (picker mode only). */
  function pick(persona) {
    if (mode() !== 'picker') throw Errors.forbidden('The role picker is switched off.');
    const t = LD_CONFIG.TEST_ACCOUNTS.find((a) => a.persona === persona);
    if (!t) throw Errors.invalid('Unknown role.');
    if (!Directory.byEmail(t.email)) throw Errors.setup('"' + t.label + '" is not set up yet. Run setupDemo in the Apps Script editor.');
    return { session: openSession(t.email) };
  }
  const redirectUri = () => Config.get('APP_URL') || ScriptApp.getService().getUrl();
  const randomToken = () => (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const query = (params) => Object.keys(params).map((k) => k + '=' + encodeURIComponent(params[k])).join('&');

  /** @param {{view?: string, req?: string}} returnTo where to land after signing in */
  function loginUrl(returnTo) {
    const state = randomToken();
    cache().put('oauth_state:' + state, JSON.stringify(returnTo || {}), STATE_SECONDS);
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + query({
      client_id: clientId(), redirect_uri: redirectUri(), response_type: 'code',
      scope: 'openid email profile', state: state, prompt: 'select_account',
    });
  }

  function decodeJwtPayload(jwt) {
    const part = String(jwt || '').split('.')[1] || '';
    const padded = part + '==='.slice((part.length + 3) % 4);
    return JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString());
  }

  /** The ID token came straight from Google over HTTPS, so its claims are checked, not its signature. */
  function validate(claims) {
    if (claims.aud !== clientId()) throw Errors.forbidden('This sign-in was not meant for Leave Desk.');
    if (ISSUERS.indexOf(claims.iss) === -1) throw Errors.forbidden('Sign-in did not come from Google.');
    if (!claims.exp || claims.exp * 1000 < Date.now()) throw Errors.forbidden('Sign-in expired. Please try again.');
    if (claims.email_verified !== true || !claims.email) throw Errors.forbidden('Your Google email is not verified.');
  }

  /** @returns {{session: string, email: string, returnTo: object}} */
  function handleCallback(params) {
    if (params.error) throw Errors.forbidden('Google sign-in was cancelled.');
    const key = 'oauth_state:' + params.state;
    const saved = params.state ? cache().get(key) : null;
    if (saved === null) throw Errors.forbidden('This sign-in link has expired. Please sign in again.');
    cache().remove(key);

    const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
      method: 'post', muteHttpExceptions: true,
      payload: { code: params.code, client_id: clientId(), client_secret: prop('OAUTH_CLIENT_SECRET'),
        redirect_uri: redirectUri(), grant_type: 'authorization_code' },
    });
    if (res.getResponseCode() !== 200) {
      console.error('Auth: token exchange failed ' + res.getResponseCode() + ' ' + res.getContentText());
      throw Errors.forbidden('Google sign-in failed. Please try again.');
    }
    const claims = decodeJwtPayload(JSON.parse(res.getContentText()).id_token);
    validate(claims);

    const email = String(claims.email).toLowerCase();
    return { session: openSession(email), email: email, returnTo: JSON.parse(saved || '{}') };
  }

  function emailFor(session) {
    if (!/^[a-f0-9]{64}$/.test(String(session || ''))) return '';
    return cache().get('session:' + session) || '';
  }

  function logout(session) {
    if (emailFor(session)) cache().remove('session:' + session);
  }

  return { mode, isEnabled, personas, pick, loginUrl, handleCallback, emailFor, logout };
})();
