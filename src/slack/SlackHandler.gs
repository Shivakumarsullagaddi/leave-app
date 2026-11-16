/**
 * SlackHandler.gs — what the Leave app does when Slack calls us.
 *
 *   /leavedesk                       opens the "Apply for leave" modal
 *   /leavedesk balance|requests|help replies from the cache
 *   /leave-balance, /leave-requests  the same, as their own commands (route by command name, then by text)
 *   App Home opened                  publishes the Home tab (balances, inbox, requests, buttons)
 *   Send request                     posts the requester's card at once, files it in the background
 *   Approve / Reject buttons         open a comment modal; the decision is filed in the background
 *
 * Slack allows 3 seconds. Nothing here reads the spreadsheet except on a person's very first
 * contact, nothing creates a trigger except Send / Approve / Reject, and every phase is timed
 * (see timing()) so a slow reply can be explained from the Executions log. handle() never throws.
 */
const SlackHandler = (() => {
  const ERROR_BLOCK = { leave_apply: 'start', leave_decide: 'comment' };
  const ACTIONS = { apply: 'apply', balance: 'balance', bal: 'balance', status: 'balance', left: 'balance',
    requests: 'requests', request: 'requests', list: 'requests', mine: 'requests', history: 'requests', help: 'help', '?': 'help' };

  let marks = [];
  let last = 0;
  const lap = (label) => { const now = Date.now(); marks.push(label + ' ' + (now - last) + 'ms'); last = now; };
  const timing = () => marks.join(' · ');

  function handle(payload) {
    marks = []; last = Date.now();
    try {
      return route_(payload);
    } catch (err) {
      const expected = err instanceof AppError;
      if (!expected) console.error('SlackHandler: ' + (err && err.stack ? err.stack : err));
      const text = expected ? err.message : 'Something went wrong: ' + (err && err.message ? err.message : err);
      if (payload.type === 'view_submission') {
        const errors = {};
        errors[ERROR_BLOCK[payload.view && payload.view.callback_id] || 'start'] = text;
        return { response_action: 'errors', errors: errors };
      }
      return payload.type === 'slash_command' ? SlackCards.ephemeral('⚠️ ' + text) : null;
    }
  }

  function route_(p) {
    verifyToken_(p);
    switch (p.type) {
      case 'url_verification': return { challenge: p.challenge };
      case 'event_callback':   return p.event && p.event.type === 'app_home_opened' && p.event.tab === 'home' ? homeOpened_(p.event.user) : null;
      case 'slash_command':    return slashCommand_(p);
      case 'block_actions':    return blockAction_(p);
      case 'view_submission':
        if (p.view.callback_id === 'leave_apply') return applySubmission_(p);
        if (p.view.callback_id === 'leave_decide') return decideSubmission_(p);
        return null;
      default: return null;
    }
  }

  // Apps Script never exposes request headers, so Slack's signing secret can't be checked here.
  // The legacy verification token (Basic Information → Verification Token) is the proof we can see.
  function verifyToken_(p) {
    const expected = SlackBot.prop('SLACK_VERIFICATION_TOKEN');
    if (expected && p.token !== expected) throw Errors.unauthorized('That request did not come from the Leave app in Slack.');
    lap('token');
  }

  /** Snapshot for a Slack user: cache first; the sheet only on first contact. */
  function snapshotFor_(slackUserId) {
    let empId = SlackCache.empIdForUser(slackUserId);
    const cached = SlackCache.snapshot(empId);
    if (cached) { lap('snapshot(cache)'); return cached; }
    if (!empId) {
      const info = SlackBot.getUser(slackUserId);
      lap('users.info');
      const email = info.user && info.user.profile && info.user.profile.email;
      if (!email) throw Errors.config('Slack did not share your email. The Leave app needs the users:read.email scope; reinstall it after adding.');
      const emp = Directory.byEmail(email);
      if (!emp) throw Errors.notRegistered(email);
      empId = emp.emp_id;
      SlackCache.linkUser(slackUserId, empId);
      SlackBot.rememberUser(email, slackUserId);
      // Written to the Employees tab by the minute trigger; no trigger is created on this fast path.
      if (emp.slack_user_id !== slackUserId) SlackJobs.enqueue({ kind: 'link', emp_id: empId, slack_user_id: slackUserId }, { kick: false });
    }
    const snap = SlackCache.load(empId);
    lap('snapshot(sheet)');
    if (!snap) throw Errors.notRegistered('');
    return snap;
  }

  /** "apply" | "balance" | "requests" | "help", from the command name first, then the first word of the text. */
  function actionFor_(command, text) {
    const suffix = (String(command || '').match(/-(balance|requests|help)$/) || [])[1];
    if (suffix) return { action: suffix, unknown: '' };
    const word = String(text || '').trim().split(/\s+/)[0].toLowerCase();
    if (!word) return { action: 'apply', unknown: '' };
    return { action: ACTIONS[word] || 'help', unknown: ACTIONS[word] ? '' : word };
  }

  function slashCommand_(p) {
    const picked = actionFor_(p.command, p.text);
    const snap = snapshotFor_(p.user_id);
    if (picked.action === 'apply') {
      SlackBot.openModal(p.trigger_id, SlackCards.applyModal(snap));
      lap('views.open');
      return null;
    }
    const meta = {
      command: (p.command + ' ' + (p.text || '')).trim(), user: p.user_id, appUrl: SlackBot.prop('APP_URL'),
      base: String(p.command || '').replace(/-(balance|requests|help)$/, ''),
      inAppDm: /^D/.test(p.channel_id || '') && p.channel_id === SlackBot.dmChannel(p.user_id),
    };
    lap('where');
    if (picked.action === 'balance') return SlackCards.balance(snap, meta);
    if (picked.action === 'requests') return SlackCards.requests(snap, meta);
    return SlackCards.help(meta, picked.unknown);
  }

  function homeOpened_(slackUserId) {
    SlackJobs.rememberHomeUser(slackUserId);
    const snap = snapshotFor_(slackUserId);
    SlackBot.publishHome(slackUserId, SlackCards.home(snap, SlackBot.prop('APP_URL')));
    lap('views.publish');
    return null;
  }

  function blockAction_(p) {
    const a = (p.actions || [])[0] || {};
    if (a.action_id === 'apply') {
      SlackBot.openModal(p.trigger_id, SlackCards.applyModal(snapshotFor_(p.user.id)));
      lap('views.open');
      return null;
    }
    if (a.action_id === 'approve' || a.action_id === 'reject') {
      const v = JSON.parse(a.value);
      SlackBot.openModal(p.trigger_id, SlackCards.decideModal({
        req_id: v.req_id, decision: a.action_id === 'approve' ? 'APPROVED' : 'REJECTED', who: v.who, when: v.when, type: v.type || '', days: v.days || '',
        channel: p.container && p.container.channel_id || '', ts: p.container && p.container.message_ts || '',
      }));
      lap('views.open');
    }
    return null;
  }

  /** Posts the requester's card immediately, then queues the filing. Touches no sheet. */
  function applySubmission_(p) {
    const v = p.view.state.values;
    const input = {
      type_id: v.type.v.selected_option.value,
      start_date: v.start.v.selected_date,
      end_date: v.end.v.selected_date,
      reason: (v.reason && v.reason.v && v.reason.v.value) || '',
    };
    if (!input.start_date || !input.end_date) throw Errors.invalid('Pick both dates.');
    if (input.end_date < input.start_date) throw Errors.invalid('The end date is before the start date.');
    const empId = p.view.private_metadata;
    const snap = SlackCache.snapshot(empId) || { name: p.user.name || 'You', team: '', role_level: '', emp_type: '' };
    const card = {
      employee: snap.name, role: SlackCards.personRole(snap), team: snap.team, type: v.type.v.selected_option.text.text,
      start_date: input.start_date, end_date: input.end_date, reason: input.reason, status: '⏳ Sending to Leave Desk…', approvers: [],
    };
    let posted = null;
    try {
      posted = SlackBot.postMessage(p.user.id, 'Leave request ' + SlackCards.dateRange(input.start_date, input.end_date), SlackCards.requestCard(card));
    } catch (err) { console.error('SlackHandler: could not post the request card: ' + err); }
    lap('chat.postMessage');
    SlackJobs.enqueue({ kind: 'submit', emp_id: empId, slack_user_id: p.user.id, input: input, card: card,
      channel: posted ? posted.channel : '', ts: posted ? posted.ts : '' });
    lap('enqueue');
    return { response_action: 'clear' };
  }

  function decideSubmission_(p) {
    const meta = JSON.parse(p.view.private_metadata);
    const comment = String((p.view.state.values.comment.v && p.view.state.values.comment.v.value) || '').trim();
    if (meta.decision === 'REJECTED' && !comment) throw Errors.invalid('Add a short reason when you reject.');
    SlackJobs.enqueue({ kind: 'decide', slack_user_id: p.user.id, req_id: meta.req_id, decision: meta.decision, comment: comment,
      who: meta.who, when: meta.when, channel: meta.channel, ts: meta.ts });
    lap('enqueue');
    return { response_action: 'clear' };
  }

  return { handle, timing };
})();
