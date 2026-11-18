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
 * Slack allows 3 seconds. Nothing here reads the spreadsheet (the background refresh links every
 * employee to Slack and caches them first), nothing creates a trigger (queued work is picked up by the
 * once-a-minute trigger), and every phase is timed (see timing()) so a slow reply can be explained
 * from the Executions log. handle() never throws.
 *
 * Determinism: the first Approve/Reject submitted in Slack claims the request (SlackCache.claim);
 * anyone after that is told who decided, at once, without a modal. Decisions are filed one at a time
 * in the order they were sent, and the sheet (under a lock) has the final word.
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

  /** Snapshot from the cache only (the normal case once setupSlack / the refresh has run). */
  function cachedSnapshot_(slackUserId) {
    const snap = SlackCache.snapshot(SlackCache.empIdForUser(slackUserId));
    if (snap) lap('snapshot(cache)');
    return snap;
  }

  const notListed = (email) => new AppError('NOT_REGISTERED', (email ? email + ' is' : 'Your Slack account is') +
    ' not in the Leave Desk directory. Ask the admin to add you — if they just did, try again in a minute.');

  /**
   * Who is this Slack user, from the cache only — never the sheet (a sheet read here is what pushed
   * Slack past its 3 seconds). Returns { snap } when ready, or { empId | email } when only the background
   * job can finish the lookup. Throws AppError when the answer is already known (not registered, scope).
   */
  function resolve_(slackUserId) {
    const cached = cachedSnapshot_(slackUserId);
    if (cached) return { snap: cached };
    if (SlackCache.isUnknown(slackUserId)) { lap('unknown(cache)'); throw notListed(''); }
    let empId = SlackCache.empIdForUser(slackUserId);
    if (!empId) {
      let info;
      try { info = SlackBot.getUser(slackUserId); } catch (err) {
        if (/user_not_found/.test(err.message)) { SlackCache.markUnknown(slackUserId); throw notListed(''); }
        throw err;
      }
      lap('users.info');
      const email = String((info.user && info.user.profile && info.user.profile.email) || '').trim().toLowerCase();
      if (!email) throw Errors.config('Slack did not share your email with the Leave app. A Slack admin must add the users:read.email scope (OAuth & Permissions) and reinstall the app.');
      const index = SlackCache.emailIndex();
      if (!index) return { email: email };          // directory not cached: the job decides
      empId = index[email];
      if (!empId) {
        SlackCache.markUnknown(slackUserId);
        SlackCache.markDirty();                       // the next minute's refresh picks up a just-added person
        throw notListed(email);
      }
      SlackCache.linkUser(slackUserId, empId);
      SlackBot.rememberUser(email, slackUserId);
    }
    const snap = SlackCache.snapshot(empId);
    if (snap) { lap('snapshot(cache)'); return { snap: snap }; }
    return { empId: empId };
  }

  /** Snapshot for replies that can't wait for the job (balance, requests): a clear "try again in a minute" otherwise. */
  function snapshotFor_(slackUserId) {
    const r = resolve_(slackUserId);
    if (r.snap) return r.snap;
    SlackCache.markDirty();
    throw new AppError('BUSY', 'Leave Desk is setting up your profile. Try again in a minute.');
  }

  /**
   * Opens the Apply form. Known person: the form at once. Known problem (not registered, scope): explained
   * in a modal at once. Otherwise a "Setting up…" modal opens and the background job fills it in
   * (within a minute) — the Slack request itself never reads the sheet, so it never times out.
   */
  function openApply_(triggerId, slackUserId) {
    let r;
    try { r = resolve_(slackUserId); } catch (err) {
      if (!(err instanceof AppError)) throw err;
      SlackBot.openModal(triggerId, SlackCards.messageModal('Leave Desk', '⚠️ ' + err.message));
      lap('views.open(message)');
      return null;
    }
    if (r.snap) {
      SlackBot.openModal(triggerId, SlackCards.applyModal(r.snap));
      lap('views.open');
      return null;
    }
    const opened = SlackBot.openModal(triggerId, SlackCards.loadingModal());
    lap('views.open(loading)');
    SlackJobs.enqueue({ kind: 'apply_view', view_id: opened.view && opened.view.id, slack_user_id: slackUserId, emp_id: r.empId || '', email: r.email || '' });
    SlackCache.markDirty();
    lap('enqueue');
    return null;
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
    if (picked.action === 'apply') return openApply_(p.trigger_id, p.user_id);
    const snap = picked.action === 'help' ? null : snapshotFor_(p.user_id);
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
    // A date, type or duration changed inside the Apply form: redraw it with the exact dates and working days.
    if (p.view && p.view.callback_id === 'leave_apply' && ['start', 'end', 'half', 'type'].indexOf(a.block_id) !== -1) {
      const snap = SlackCache.snapshot(p.view.private_metadata) || snapshotFor_(p.user.id);
      SlackBot.updateView(p.view.id, p.view.hash, SlackCards.applyModal(snap, SlackCards.applyState(p.view.state && p.view.state.values)));
      lap('views.update');
      return null;
    }
    if (a.action_id === 'apply') return openApply_(p.trigger_id, p.user.id);
    if (a.action_id === 'approve' || a.action_id === 'reject') {
      const v = JSON.parse(a.value);
      // Someone already decided (or this person already did): say so on the card at once, no modal.
      const taken = SlackCache.firstIsFinal() ? SlackCache.claimOf(v.req_id) : null;
      if (taken) {
        const channel = p.container && p.container.channel_id;
        const ts = p.container && p.container.message_ts;
        if (channel && ts) SlackBot.updateMessage(channel, ts, SlackCards.claimText(taken, p.user.id).replace(/\*/g, ''), SlackCards.claimedCard(v, taken, p.user.id));
        lap('chat.update(claimed)');
        return null;
      }
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
    const s = SlackCards.applyState(v);
    const input = { type_id: s.type_id, start_date: s.start, end_date: s.end, half_day: s.half, reason: s.reason };
    if (!input.start_date) throw Errors.invalid('Pick the first day.');
    if (!input.end_date) { const errors = { end: 'Pick the last day. For one day, pick the same date.' }; return { response_action: 'errors', errors: errors }; }
    if (input.end_date < input.start_date) { const errors = { end: 'The last day is before the first day.' }; return { response_action: 'errors', errors: errors }; }
    const empId = p.view.private_metadata;
    const snap = SlackCache.snapshot(empId);
    // Checked here from the cache so a mistake stays in the form (the job checks again against the sheet).
    if (snap) {
      const problem = cachedProblem_(snap, s);
      if (problem) return { response_action: 'errors', errors: { end: problem } };
    }
    const card = {
      employee: snap ? snap.name : (p.user.name || 'You'), role: snap ? SlackCards.personRole(snap) : '', team: snap ? snap.team : '',
      type: v.type.v.selected_option.text.text, start_date: input.start_date, end_date: input.end_date, reason: input.reason,
      status: '⏳ Sending to Leave Desk…', approvers: [], submitted_at: DateUtil.now(),
    };
    if (input.half_day) card.days = 0.5;
    // The cache already knows the days and the approvers, so the first card is the real one; the job only adds the ID.
    if (snap && snap.approvers) {
      const q = SlackCards.quote(snap, s);
      const auto = snap.approvers.some((a) => a.auto);
      Object.assign(card, { days: q.days, lop: q.lop, status: auto ? 'APPROVED' : 'PENDING', approvers: auto ? [] : snap.approvers.filter((a) => !a.auto) });
    }
    let posted = null;
    try {
      posted = SlackBot.postMessage(p.user.id, 'Leave request ' + SlackCards.dateRange(input.start_date, input.end_date), SlackCards.requestCard(card));
    } catch (err) { console.error('SlackHandler: could not post the request card: ' + err); }
    lap('chat.postMessage');
    SlackJobs.enqueue({ kind: 'submit', emp_id: empId, slack_user_id: p.user.id, input: input, card: card,
      channel: posted ? posted.channel : '', ts: posted ? posted.ts : '' });
    if (snap && card.days !== undefined) {
      SlackCache.addPending(empId, { req_id: '', emp_id: empId, employee: card.employee, type: card.type, type_id: input.type_id,
        start_date: input.start_date, end_date: input.end_date, days: Number(card.days) || 0, lop: Number(card.lop) || 0,
        status: card.status, reason: input.reason, submitted_at: card.submitted_at, approvers: card.approvers },
      Math.max(0, (Number(card.days) || 0) - (Number(card.lop) || 0)));
    }
    lap('enqueue');
    return { response_action: 'clear' };
  }

  /** What the sheet would refuse, judged from the cached snapshot: overlap, weekend-only, no approver. '' if fine. */
  function cachedProblem_(snap, s) {
    const clash = (snap.requests || []).find((r) => (r.status === 'PENDING' || r.status === 'APPROVED') &&
      DateUtil.overlaps(r.start_date, r.end_date, s.start, s.end));
    if (clash) return 'You already have leave on some of these dates' + (clash.req_id ? ' (' + clash.req_id + ')' : ' (just sent)') + '.';
    if (DateUtil.year(s.start) !== DateUtil.year(s.end)) return 'Leave can’t run into the next year. Send one request for each year.';
    if (SlackCards.quote(snap, s).days <= 0) return 'These dates are all weekends or holidays, so no leave is needed.';
    if (snap.approvers && !snap.approvers.length) return 'No approver is set up for your team yet. Ask the admin.';
    return '';
  }

  function decideSubmission_(p) {
    const meta = JSON.parse(p.view.private_metadata);
    const comment = String((p.view.state.values.comment.v && p.view.state.values.comment.v.value) || '').trim();
    if (meta.decision === 'REJECTED' && !comment) throw Errors.invalid('Add a short reason when you reject.');
    if (SlackCache.firstIsFinal()) {
      const me = SlackCache.snapshot(SlackCache.empIdForUser(p.user.id));
      const result = SlackCache.claim(meta.req_id, { slack_user_id: p.user.id, by: me ? me.name : (p.user.name || ''), decision: meta.decision, at: DateUtil.now() });
      lap('claim');
      if (!result.won) {
        if (result.claim.slack_user_id === p.user.id && !result.claim.final) return { response_action: 'clear' };   // double submit
        return { response_action: 'errors', errors: { comment: SlackCards.claimText(result.claim, p.user.id).replace(/\*/g, '') } };
      }
    }
    SlackJobs.enqueue({ kind: 'decide', slack_user_id: p.user.id, req_id: meta.req_id, decision: meta.decision, comment: comment,
      who: meta.who, when: meta.when, channel: meta.channel, ts: meta.ts });
    lap('enqueue');
    return { response_action: 'clear' };
  }

  return { handle, timing };
})();
