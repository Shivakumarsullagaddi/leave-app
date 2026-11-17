/**
 * Messages.gs — WHAT each notification says, independent of HOW it's delivered.
 *
 * A message is channel-neutral:
 *   { subject, tone, badge, parts, fields, comment, recipients, link }
 * `parts` mixes plain strings with { person } objects, so Slack can render an
 * @mention and email can render a name. Add an event = add one template.
 */
const Messages = (() => {
  const ROLE_LABEL = { TEAM_LEAD: 'Team Lead', CSUITE: 'C-suite', SPECIFIC: 'Approver', ADMIN: 'Admin', SYSTEM: 'Auto' };

  const fmtDate = (iso) => Utilities.formatDate(DateUtil.parse(iso), 'UTC', 'EEE d MMM');
  const dateRange = (r) => (r.start_date === r.end_date ? fmtDate(r.start_date) : fmtDate(r.start_date) + ' – ' + fmtDate(r.end_date));
  const dayText = (r) => (r.half_day ? 'Half day' : r.days + (r.days === 1 ? ' day' : ' days')) +
    (Number(r.lop_days) > 0 ? ' (' + r.paid_days + ' paid, ' + r.lop_days + ' Loss of Pay)' : '');

  const person = (empId) => ({ person: Directory.profile(Directory.employee(empId)) });
  const people = (ids) => ids.map(person).filter((p) => p.person);
  const joinPeople = (list) => list.reduce((acc, p, i) => acc.concat(i === 0 ? [p] : [i === list.length - 1 ? ' and ' : ', ', p]), []);

  const approverIds = (r, filter) => r.approvals.filter((a) => a.approver_id !== Directory.SYSTEM && (!filter || filter(a))).map((a) => a.approver_id);
  const pendingIds = (r) => approverIds(r, (a) => a.decision === 'PENDING');
  const joinNames = (names) => names.reduce((acc, n, i) => acc + (i === 0 ? '' : i === names.length - 1 ? ' and ' : ', ') + n, '');

  const DECISION = { PENDING: '⏳', APPROVED: '✅', REJECTED: '❌', AUTO: '✅', NO_ACTION: '—' };
  function statusText(r) {
    const waiting = r.approvals.filter((a) => a.decision === 'PENDING').map((a) => a.name);
    const by = r.final_by_name && r.final_by !== Directory.SYSTEM ? ' by ' + r.final_by_name : '';
    switch (r.status) {
      case 'PENDING':   return '⏳ Waiting for ' + (waiting.length ? joinNames(waiting) : 'approval') + (waiting.length > 1 ? ' (' + (waiting.length > 2 ? 'any' : 'either') + ' one is enough)' : '');
      case 'APPROVED':  return '✅ Approved' + (by || ' automatically');
      case 'REJECTED':  return '❌ Rejected' + by;
      case 'CANCELLED': return '🚫 Cancelled by the requester';
      default:          return r.status;
    }
  }

  function fields(r) {
    const approvers = r.approvals.filter((a) => a.approver_id !== Directory.SYSTEM);
    const list = [
      { label: 'Employee', value: r.employee.name + (r.employee.team_name ? ' · ' + r.employee.team_name : '') },
      { label: 'Leave type', value: r.type_name },
      { label: 'Dates', value: dateRange(r) },
      { label: 'Days', value: dayText(r) },
      { label: 'Status', value: statusText(r) },
    ];
    if (approvers.length) list.push({ label: 'Approvers', value: approvers.map((a) => DECISION[a.decision] + ' ' + a.name + (ROLE_LABEL[a.role] ? ' (' + ROLE_LABEL[a.role] + ')' : '')).join('\n') });
    list.push({ label: 'Request', value: r.req_id + (r.submitted_at ? ' · sent ' + r.submitted_at : '') });
    return list;
  }

  function link(view, reqId) {
    const base = Config.get('APP_URL');
    return base ? base + '?view=' + view + '&req=' + encodeURIComponent(reqId) : '';
  }

  const TEMPLATES = {
    SUBMITTED: (r) => {
      const approvers = people(pendingIds(r));
      return {
        subject: 'Leave request from ' + r.employee.name + ': ' + dateRange(r),
        tone: r.over_quota ? 'warn' : 'info', badge: r.over_quota ? 'Over quota' : '',
        parts: [person(r.emp_id), ' is asking for leave. Over to '].concat(joinPeople(approvers), [approvers.length > 2 ? ' — any one approval is enough.' : approvers.length > 1 ? ' — either approval is enough.' : '.']),
        comment: r.reason ? 'Reason: ' + r.reason : '',
        recipients: approvers, actors: pendingIds(r), link: link('approvals', r.req_id),
      };
    },
    AUTO_APPROVED: (r) => ({
      subject: r.employee.name + ' is on leave: ' + dateRange(r),
      tone: 'good', badge: 'Approved',
      parts: [person(r.emp_id), ' is on leave (C-suite, approved automatically).'],
      recipients: people([r.emp_id]), link: link('requests', r.req_id),
    }),
    APPROVED: (r, actor) => {
      const role = ROLE_LABEL[(r.approvals.find((a) => a.approver_id === actor.emp_id) || {}).role] || '';
      return {
        subject: 'Approved: your leave ' + dateRange(r),
        tone: 'good', badge: 'Approved',
        parts: ['Approved by ', person(actor.emp_id), role ? ' (' + role + ')' : '', '. ', person(r.emp_id), ', your leave is confirmed.'],
        recipients: people([r.emp_id].concat(pendingIds(r))), actors: pendingIds(r), link: link('requests', r.req_id),
      };
    },
    APPROVAL_ADDED: (r, actor) => ({
      subject: actor.name + ' also approved your leave ' + dateRange(r),
      tone: 'good', badge: '',
      parts: [person(actor.emp_id), ' also approved. On record: ' +
        r.approvals.filter((a) => a.decided_at && a.decision === 'APPROVED').map((a) => a.name + ' ' + a.decided_at.slice(11)).join(', ') + '.'],
      recipients: people([r.emp_id]), link: link('requests', r.req_id),
    }),
    REJECTED: (r, actor) => {
      const mine = r.approvals.find((a) => a.approver_id === actor.emp_id) || {};
      return {
        subject: 'Not approved: your leave ' + dateRange(r),
        tone: 'bad', badge: 'Rejected',
        parts: ['Rejected by ', person(actor.emp_id), '. ', person(r.emp_id), ', your leave request was not approved.'],
        comment: mine.comment ? actor.name + ': ' + mine.comment : '',
        recipients: people([r.emp_id].concat(approverIds(r, (a) => a.approver_id !== actor.emp_id))), link: link('requests', r.req_id),
      };
    },
    CANCELLED: (r) => ({
      subject: r.employee.name + ' cancelled leave ' + dateRange(r),
      tone: 'info', badge: 'Cancelled',
      parts: [person(r.emp_id), ' cancelled their leave request. No action needed.'],
      recipients: people(approverIds(r)), link: '',
    }),
  };

  /** @returns {object|null} message for an event, or null if the event has no template. */
  function build(event, request, actor) {
    const template = TEMPLATES[event];
    if (!template || !request) return null;
    return Object.assign({ event: event, fields: fields(request), comment: '', badge: '', actors: [], reqId: request.req_id,
      summary: { employee: request.employee.name, dates: dateRange(request), type: request.type_name, days: dayText(request) } },
      template(request, actor || {}));
  }

  return { build };
})();
