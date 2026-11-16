/**
 * SlackCards.gs — what the Leave app looks like in Slack (Block Kit only, no data access).
 *
 * Every card answers the same four questions with labels, never a one-liner:
 *   who asked · what for (type, dates, working days, reason) · where it stands (status) · who decides (approvers).
 *
 *   fromMessage   notification cards (Messages.gs → blocks), with Approve/Reject for approvers
 *   requestCard   the requester's own card: posted when they click Send, updated when filed / decided
 *   applyModal    the "Apply for leave" form      decideModal   Approve / Reject with a comment
 *   home          the App Home tab                balance / requests / help   slash-command replies
 *   reply         wraps a slash reply: in_channel inside the Leave app DM (the command stays visible),
 *                 ephemeral elsewhere with a "you asked" line so the request is never lost.
 */
const SlackCards = (() => {
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const plain = (t) => ({ type: 'plain_text', text: String(t).slice(0, 150), emoji: true });
  const md = (t) => ({ type: 'mrkdwn', text: t });
  const header = (t) => ({ type: 'header', text: plain(t) });
  const section = (t) => ({ type: 'section', text: md(t) });
  /** Two-column labelled fields. Values are escaped unless raw = true (for <@mentions>). */
  const fields = (pairs, raw) => ({ type: 'section', fields: pairs.slice(0, 10).map((p) => md('*' + esc(p[0]) + '*\n' + (raw ? p[1] : esc(p[1])))) });
  const context = (t) => ({ type: 'context', elements: [md(t)] });
  const divider = () => ({ type: 'divider' });
  const actions = (elements) => ({ type: 'actions', elements: elements });
  const button = (text, actionId, value, style) => {
    const b = { type: 'button', text: plain(text), action_id: actionId, value: String(value) };
    if (style) b.style = style;
    return b;
  };
  const linkButton = (text, url) => ({ type: 'button', text: plain(text), url: url, action_id: 'open_link' });
  const appName = () => esc(LD_CONFIG.APP_NAME);

  const fmtDate = (iso) => Utilities.formatDate(DateUtil.parse(iso), 'UTC', 'EEE d MMM');
  const dateRange = (s, e) => (s === e ? fmtDate(s) : fmtDate(s) + ' → ' + fmtDate(e));
  const dayText = (days, lop) => (days === 0.5 ? 'Half day' : days + (days === 1 ? ' day' : ' days')) + (lop > 0 ? ' (' + lop + ' Loss of Pay)' : '');
  const stamp = (s) => String(s || '').slice(0, 16).replace('T', ' ');

  const ROLE = { TEAM_LEAD: 'Team Lead', CSUITE: 'C-suite', SPECIFIC: 'Approver', SYSTEM: 'Automatic' };
  /** "Team Lead", "Intern" … from the Employees row. */
  const personRole = (p) => (p.role_level === 'CSUITE' ? 'C-suite' : p.role_level === 'LEAD' ? 'Team Lead'
    : p.emp_type === 'INT' ? 'Intern' : p.emp_type === 'CON' ? 'Contractor' : 'Employee');
  const who = (p) => esc(p.name) + ' · ' + personRole(p) + (p.team ? ' · ' + esc(p.team) : '');

  const STATUS = { PENDING: '⏳ Waiting for approval', APPROVED: '✅ Approved', REJECTED: '❌ Rejected', CANCELLED: '🚫 Cancelled' };
  const DECISION = { PENDING: '⏳', APPROVED: '✅', REJECTED: '❌', AUTO: '✅', NO_ACTION: '—' };
  const DECISION_WORD = { PENDING: 'waiting', APPROVED: 'approved', REJECTED: 'rejected', AUTO: 'approved automatically', NO_ACTION: 'no action needed' };
  const pendingOf = (list) => (list || []).filter((a) => a.decision === 'PENDING');
  const names = (list) => list.map((a) => esc(a.name)).reduce((acc, n, i) => acc + (i === 0 ? '' : i === list.length - 1 ? ' or ' : ', ') + n, '');

  /** One line per approver: ✅ *Test Lead* · Team Lead · approved 2026-11-16 10:42 */
  const approverLines = (list) => (list || []).map((a) => DECISION[a.decision] + ' *' + esc(a.name) + '*' +
    (ROLE[a.role] ? ' · ' + ROLE[a.role] : '') + ' · ' + (DECISION_WORD[a.decision] || a.decision) +
    (a.decided_at && a.decision !== 'PENDING' ? ' ' + esc(stamp(a.decided_at)) : '')).join('\n') || '—';

  /** Status sentence from a status code + approvers; free text (e.g. "⏳ Sending…") passes through. */
  function statusText(status, approvers) {
    if (!STATUS[status]) return esc(status);
    const list = approvers || [];
    const by = (d) => { const a = list.find((x) => x.decision === d); return a ? ' by ' + esc(a.name) : ''; };
    if (status === 'PENDING') {
      const waiting = pendingOf(list);
      return '⏳ Waiting for ' + (waiting.length ? names(waiting) : 'approval') + (waiting.length > 1 ? ' — either one is enough' : '');
    }
    if (status === 'APPROVED') return '✅ Approved' + (by('APPROVED') || by('AUTO') || (list.some((a) => a.decision === 'AUTO') ? ' automatically' : ''));
    if (status === 'REJECTED') return '❌ Rejected' + by('REJECTED');
    return STATUS[status];
  }

  /** ██████░░░░ — ten cells, filled by what is left. */
  const bar = (available, quota) => {
    const n = quota > 0 ? Math.max(0, Math.min(10, Math.round((available / quota) * 10))) : 0;
    return '█'.repeat(n) + '░'.repeat(10 - n);
  };
  const balanceBlocks = (snap) => snap.balances.map((b) => {
    const detail = [b.used ? b.used + ' used' : '', b.pending ? b.pending + ' pending approval' : ''].filter(String).join(' · ');
    return section('*' + esc(b.name) + '*\n`' + bar(b.available, b.quota) + '`  *' + b.available + ' of ' + b.quota + '* days left' + (detail ? '\n_' + detail + '_' : ''));
  });
  const mainButtons = (appUrl, value) => actions([button('Request leave', 'apply', value || 'card', 'primary')].concat(appUrl ? [linkButton('Open Leave Desk', appUrl)] : []));

  const TITLE = {
    SUBMITTED: '🌴 Leave request — your decision needed', AUTO_APPROVED: '✅ Leave logged', APPROVED: '✅ Leave approved',
    APPROVAL_ADDED: '✅ Another approval', REJECTED: '❌ Leave not approved', CANCELLED: '🚫 Request cancelled',
  };
  const FIELD_LABEL = { Employee: 'Requested by', Days: 'Working days' };

  const renderPart = (part) => {
    if (typeof part === 'string') return esc(part);
    const p = part.person;
    return p.slack_user_id ? '<@' + p.slack_user_id + '>' : '*' + esc(p.name) + '*';
  };

  const decideValue = (s) => JSON.stringify({ req_id: s.req_id, who: s.employee, when: s.dates, type: s.type || '', days: s.days || '' });
  const decideButtons = (s) => [button('Approve', 'approve', decideValue(s), 'primary'), button('Reject', 'reject', decideValue(s), 'danger')];

  /** A notification from Messages.gs, as the given person should see it. */
  function fromMessage(msg, viewerEmpId) {
    const mine = (msg.actors || []).indexOf(viewerEmpId) !== -1;
    const blocks = [header(TITLE[msg.event] || 'Leave Desk'), section(msg.parts.map(renderPart).join(''))];
    blocks.push(fields(msg.fields.filter((f) => f.label !== 'Request').map((f) => [FIELD_LABEL[f.label] || f.label, f.value])));
    if (msg.comment) blocks.push(section('💬 ' + esc(msg.comment)));
    if (mine) {
      blocks.push(section('👉 *Your decision is needed.* ' + (msg.event === 'SUBMITTED'
        ? 'The first approval confirms this leave; any rejection closes it. You can change a decision until the leave starts.'
        : 'Someone else already approved. You can still reject until the leave starts.')));
    }
    const row = mine ? decideButtons(Object.assign({ req_id: msg.reqId }, msg.summary)) : [];
    if (msg.link) row.push(linkButton('Open in Leave Desk', msg.link));
    if (row.length) blocks.push(actions(row));
    const ref = msg.fields.find((f) => f.label === 'Request');
    blocks.push(context(esc(ref ? ref.value : msg.reqId) + ' · ' + appName()));
    return blocks;
  }

  /**
   * The requester's own card. r = { title?, employee, role?, team, type, start_date, end_date, days, lop, reason,
   *   status (code or text), approvers [{name, role, decision, decided_at}], req_id, submitted_at, note, link }
   */
  function requestCard(r) {
    const waiting = pendingOf(r.approvers);
    const blocks = [
      header(r.title || '📝 Your leave request'),
      section('*Status*\n' + statusText(r.status, r.approvers)),
      fields([
        ['Requested by', r.employee + (r.role ? ' · ' + r.role : '') + (r.team ? ' · ' + r.team : '')],
        ['Leave type', r.type],
        ['Dates', dateRange(r.start_date, r.end_date)],
        ['Working days', r.days === undefined || r.days === null ? 'Counting…' : dayText(Number(r.days), Number(r.lop) || 0)],
      ]),
    ];
    if (r.reason) blocks.push(section('*Reason*\n' + esc(r.reason)));
    blocks.push(section('*Approvers*\n' + approverLines(r.approvers) +
      (waiting.length > 1 ? '\n_Either approval is enough. Any rejection closes the request._' : '')));
    if (r.note) blocks.push(section(r.note));
    if (r.link) blocks.push(actions([linkButton('Open in Leave Desk', r.link)]));
    blocks.push(context((r.req_id ? esc(r.req_id) + ' · ' : '') + (r.submitted_at ? 'sent ' + esc(stamp(r.submitted_at)) + ' · ' : '') + appName()));
    return blocks;
  }

  function applyModal(snap) {
    const options = snap.balances.map((b) => ({ text: plain(b.name), value: b.type_id }));
    const today = DateUtil.today();
    return {
      type: 'modal', callback_id: 'leave_apply', private_metadata: snap.emp_id,
      title: plain('Apply for leave'), submit: plain('Send request'), close: plain('Cancel'),
      blocks: [
        section('*' + who(snap) + '* · ' + snap.year),
        fields(snap.balances.map((b) => [b.name, b.available + ' of ' + b.quota + ' days left' + (b.pending ? ' · ' + b.pending + ' pending' : '')])),
        divider(),
        { type: 'input', block_id: 'type', label: plain('Leave type'),
          element: { type: 'static_select', action_id: 'v', options: options, initial_option: options[0] } },
        { type: 'input', block_id: 'start', label: plain('First day'), element: { type: 'datepicker', action_id: 'v', initial_date: today } },
        { type: 'input', block_id: 'end', label: plain('Last day'), element: { type: 'datepicker', action_id: 'v', initial_date: today } },
        { type: 'input', block_id: 'reason', optional: true, label: plain('Reason'),
          element: { type: 'plain_text_input', action_id: 'v', multiline: true, placeholder: plain('Optional, but it helps your approvers') } },
        context('Weekends and holidays are not counted. Days beyond your balance become Loss of Pay.'),
      ],
    };
  }

  /** meta = { req_id, decision, who, when, type, days, channel, ts } travels in private_metadata. */
  function decideModal(meta) {
    const approve = meta.decision === 'APPROVED';
    return {
      type: 'modal', callback_id: 'leave_decide', private_metadata: JSON.stringify(meta),
      title: plain(approve ? 'Approve leave' : 'Reject leave'), submit: plain(approve ? 'Approve' : 'Reject'), close: plain('Cancel'),
      blocks: [
        section(approve ? 'You are about to *approve* this request.' : 'You are about to *reject* this request. The requester will see your reason.'),
        fields([['Requested by', meta.who], ['Leave type', meta.type || '—'], ['Dates', meta.when], ['Working days', meta.days || '—']]),
        context(esc(meta.req_id)),
        { type: 'input', block_id: 'comment', optional: approve, label: plain(approve ? 'Comment (optional)' : 'Reason (the requester will see this)'),
          element: { type: 'plain_text_input', action_id: 'v', multiline: true } },
      ],
    };
  }

  const requestLine = (r) => (DECISION[r.status] || '🚫') + ' *' + esc(r.type) + '* · ' + dateRange(r.start_date, r.end_date) + ' · ' + dayText(r.days, r.lop) +
    '\n        ' + statusText(r.status, r.approvers) + ' · ' + esc(r.req_id);

  function home(snap, appUrl) {
    const blocks = [
      header('🌴 Leave Desk'),
      section('Hi *' + esc(snap.name) + '* · ' + personRole(snap) + (snap.team ? ' · ' + esc(snap.team) : '') + ' · ' + snap.year),
      section('*📊 Your balance*'),
    ].concat(balanceBlocks(snap), [mainButtons(appUrl, 'home')]);
    if (snap.inbox.length) {
      blocks.push(divider(), section('*⏳ Waiting for your decision (' + snap.inbox.length + ')*\n_The first approval confirms a request; any rejection closes it._'));
      snap.inbox.slice(0, 10).forEach((r) => {
        blocks.push(fields([['Requested by', r.employee], ['Leave type', r.type], ['Dates', dateRange(r.start_date, r.end_date)], ['Working days', dayText(r.days, r.lop)]]));
        blocks.push(context((r.reason ? '💬 ' + esc(r.reason) + ' · ' : '') + esc(r.req_id) + (r.submitted_at ? ' · sent ' + esc(stamp(r.submitted_at)) : '')));
        blocks.push(actions(decideButtons({ req_id: r.req_id, employee: r.employee, dates: dateRange(r.start_date, r.end_date), type: r.type, days: dayText(r.days, r.lop) })));
      });
    }
    blocks.push(divider(), section('*🗂 Your requests · ' + snap.year + '*'));
    if (snap.requests.length) snap.requests.forEach((r) => blocks.push(section(requestLine(r))));
    else blocks.push(context('No requests yet. Click *Request leave* to start.'));
    blocks.push(context('Updated ' + esc(DateUtil.now()) + ' · ' + appName()));
    return { type: 'home', blocks: blocks };
  }

  /**
   * Slash-command reply. meta = { inAppDm, command, user }.
   * Inside the Leave app DM the reply is in_channel, so Slack keeps the person's command on screen
   * above the answer. Anywhere else it is ephemeral, with a "you asked" line so the request is visible.
   */
  function reply(meta, text, blocks) {
    const m = meta || {};
    if (m.inAppDm) return { response_type: 'in_channel', text: text, blocks: blocks };
    const asked = m.command ? [context('`' + esc(m.command) + '` · asked by ' + (m.user ? '<@' + m.user + '>' : 'you') + ' · only you can see this reply')] : [];
    return { response_type: 'ephemeral', text: text, blocks: asked.concat(blocks) };
  }
  const ephemeral = (text, blocks) => reply(null, text, blocks);

  function balance(snap, meta) {
    const blocks = [header('📊 Leave balance · ' + snap.year), context(who(snap))]
      .concat(balanceBlocks(snap), [mainButtons(meta && meta.appUrl, 'balance'),
        context('Credits are added every quarter. Days beyond your balance become Loss of Pay. · ' + appName())]);
    return reply(meta, 'Leave balance for ' + snap.name + ': ' + snap.balances.map((b) => b.name + ' ' + b.available + '/' + b.quota).join(', '), blocks);
  }

  function requests(snap, meta) {
    const n = snap.requests.length;
    const blocks = [header('🗂 Your leave requests · ' + snap.year), context(who(snap) + ' · ' + (n ? n + (n === 1 ? ' request' : ' requests') + ' this year' : 'no requests yet'))];
    snap.requests.forEach((r) => {
      blocks.push(divider(), fields([['Leave type', r.type], ['Dates', dateRange(r.start_date, r.end_date)], ['Working days', dayText(r.days, r.lop)], ['Status', statusText(r.status, r.approvers)]], true));
      blocks.push(context((r.reason ? '💬 ' + esc(r.reason) + ' · ' : '') + 'Approvers: ' + ((r.approvers || []).map((a) => DECISION[a.decision] + ' ' + esc(a.name)).join('  ') || '—') + ' · ' + esc(r.req_id)));
    });
    if (!n) blocks.push(section('No requests this year yet. Click *Request leave* to start.'));
    blocks.push(mainButtons(meta && meta.appUrl, 'requests'));
    return reply(meta, snap.name + ': ' + (n ? n + ' leave requests this year' : 'no leave requests yet'), blocks);
  }

  function help(meta, unknown) {
    const cmd = esc((meta && meta.base) || '/leavedesk');
    const blocks = [header('🌴 Leave Desk in Slack')];
    if (unknown) blocks.push(section('I don’t know `' + esc(unknown) + '`. Here is what I can do:'));
    blocks.push(fields([
      [cmd, 'Open the leave request form'], [cmd + ' balance', 'Days you have left, by leave type'],
      [cmd + ' requests', 'Your requests this year, with status'], [cmd + ' help', 'This message'],
    ]));
    blocks.push(section('*Tip:* type `/` and start typing *leave* — Slack lists every Leave Desk command, so nothing has to be typed in full.'));
    blocks.push(section('*Leave app → Home* (Apps in your sidebar) shows your balance, requests waiting for your decision and your history. ' +
      'Approvals arrive as direct messages with *Approve* / *Reject* buttons.'));
    blocks.push(context(appName()));
    return reply(meta, 'Leave Desk help', blocks);
  }

  return { fromMessage, requestCard, applyModal, decideModal, home, balance, requests, help, reply, ephemeral, dateRange, dayText, statusText, personRole, STATUS };
})();
