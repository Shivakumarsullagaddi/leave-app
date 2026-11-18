/**
 * SlackBot.gs — the Slack Web API calls the Leave app makes, with the bot token.
 *
 * Secrets come from Script Properties only (never the sheet), so a Slack call never
 * has to open the spreadsheet: SLACK_BOT_TOKEN (xoxb-…), SLACK_VERIFICATION_TOKEN, APP_URL.
 *
 * Arguments are always sent form-encoded: Slack's read methods (users.info, auth.test …)
 * silently ignore a JSON body and answer "user_not_found". Objects (view, blocks) are
 * JSON-encoded inside the form, which every method accepts.
 */
const SlackBot = (() => {
  const prop = (key) => PropertiesService.getScriptProperties().getProperty(key) || '';
  const cache = () => CacheService.getScriptCache();
  const SIX_HOURS = 21600;

  function token_() {
    const token = prop('SLACK_BOT_TOKEN');
    if (!token) throw Errors.config('SLACK_BOT_TOKEN is not set in Script Properties.');
    return token;
  }

  function request_(method, args, token) {
    const form = {};
    Object.keys(args || {}).forEach((k) => {
      if (args[k] === undefined || args[k] === null) return;
      form[k] = typeof args[k] === 'object' ? JSON.stringify(args[k]) : String(args[k]);
    });
    return { url: 'https://slack.com/api/' + method, method: 'post', headers: { Authorization: 'Bearer ' + token }, payload: form, muteHttpExceptions: true };
  }

  function parse_(method, response) {
    const result = JSON.parse(response.getContentText());
    if (!result.ok) throw Errors.slack('Slack said "' + result.error + '" for ' + method + '.');
    const headers = response.getAllHeaders ? response.getAllHeaders() : {};
    result.scopes = String(headers['x-oauth-scopes'] || headers['X-OAuth-Scopes'] || '').split(',').map((s) => s.trim()).filter(String);
    return result;
  }

  function call(method, args) {
    const r = request_(method, args, token_());
    return parse_(method, UrlFetchApp.fetch(r.url, r));
  }

  /**
   * Several calls in one round-trip (UrlFetchApp.fetchAll runs them in parallel).
   * calls = [[method, args], …]. Returns, in order, each result or the Error it raised. Never throws per call.
   */
  function callAll(calls) {
    if (!calls.length) return [];
    const token = token_();
    const responses = UrlFetchApp.fetchAll(calls.map((c) => request_(c[0], c[1], token)));
    return responses.map((res, i) => { try { return parse_(calls[i][0], res); } catch (err) { return err; } });
  }

  const authTest = () => call('auth.test', {});
  const getUser = (userId) => call('users.info', { user: userId });
  const lookupByEmail = (email) => call('users.lookupByEmail', { email: email });
  const openModal = (triggerId, view) => call('views.open', { trigger_id: triggerId, view: view });
  const publishHome = (userId, view) => call('views.publish', { user_id: userId, view: view });
  const updateView = (viewId, hash, view) => call('views.update', { view_id: viewId, hash: hash, view: view });
  const updateMessage = (channel, ts, text, blocks) => call('chat.update', { channel: channel, ts: ts, text: text, blocks: blocks });
  /** Posting to a member ID (U…) answers with the DM channel (D…); remember it so slash replies know they are in the app DM. */
  function postMessage(channel, text, blocks) {
    const result = call('chat.postMessage', { channel: channel, text: text, blocks: blocks });
    if (/^U/.test(channel) && result.channel) rememberDm(channel, result.channel);
    return result;
  }

  const emailKey = (email) => 'slack:email:' + String(email).toLowerCase();
  const rememberUser = (email, userId) => cache().put(emailKey(email), userId, SIX_HOURS);

  const dmKey = (userId) => 'slack:dm:' + userId;
  const rememberDm = (userId, channelId) => { if (userId && channelId) cache().put(dmKey(userId), channelId, SIX_HOURS); };
  /** The person's DM channel with the Leave app (D…), remembered for six hours; '' if Slack won't say (needs im:write). */
  function dmChannel(userId) {
    const hit = cache().get(dmKey(userId));
    if (hit) return hit;
    try {
      const id = call('conversations.open', { users: userId }).channel.id;
      rememberDm(userId, id);
      return id;
    } catch (err) {
      console.error('SlackBot: conversations.open failed (' + err.message + '). Add the im:write scope so replies inside the Leave app DM stay visible.');
      return '';
    }
  }

  /** Slack member ID for an email, remembered for six hours; '' if Slack doesn't know the address. */
  function userIdByEmail(email) {
    if (!email) return '';
    const hit = cache().get(emailKey(email));
    if (hit) return hit === '-' ? '' : hit;   // '-' = Slack said this address is not a member
    try {
      const id = lookupByEmail(email).user.id;
      rememberUser(email, id);
      return id;
    } catch (err) {
      if (err instanceof AppError && /users_not_found/.test(err.message)) return '';
      throw err;
    }
  }

  /**
   * Slack member IDs for many emails at once: { email: 'U…' | '' (not on Slack) }.
   * Emails whose lookup failed for another reason are left out, so they are retried next time.
   */
  function userIdsByEmail(emails) {
    const out = {};
    const ask = [];
    emails.forEach((email) => {
      const hit = cache().get(emailKey(email));
      if (hit !== null && hit !== undefined) out[email] = hit === '-' ? '' : hit;
      else ask.push(email);
    });
    for (let i = 0; i < ask.length; i += 25) {
      const batch = ask.slice(i, i + 25);
      callAll(batch.map((email) => ['users.lookupByEmail', { email: email }])).forEach((res, j) => {
        const email = batch[j];
        if (!(res instanceof Error)) { out[email] = res.user.id; rememberUser(email, res.user.id); }
        else if (/users_not_found/.test(res.message)) { out[email] = ''; cache().put(emailKey(email), '-', SIX_HOURS); }
        else console.error('SlackBot: lookup ' + email + ': ' + res.message);
      });
    }
    return out;
  }

  return { prop, call, callAll, authTest, getUser, lookupByEmail, openModal, publishHome, updateView, postMessage, updateMessage, userIdByEmail, userIdsByEmail, rememberUser, dmChannel, rememberDm };
})();
