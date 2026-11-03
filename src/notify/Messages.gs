/**
 * Messages.gs — WHAT each notification says, independent of HOW it's delivered.
 *
 * A message is channel-neutral:
 *   { subject, tone, badge, parts, fields, comment, recipients, link }
 * `parts` mixes plain strings with { person } objects, so Slack can render an
 * @mention and email can render a name. Add an event = add one template.
 */
const Messages = (() => {
  const ROLE_LABEL = { TEAM_LEAD: 'Team Lead', CSUITE: 'C-suite', SPECIFIC: 'Approver', SYSTEM: 'Auto' };

  const fmtDate = (iso) => Utilities.formatDate(DateUtil.parse(iso), 'UTC', 'EEE d MMM');
  const dateRange = (r) => (r.start_date === r.end_date ? fmtDate(r.start_date) : fmtDate(r.start_date) + ' – ' + fmtDate(r.end_date));
  const dayText = (r) => (r.half_day ? 'Half day' : r.days + (r.days === 1 ? ' day' : ' days')) +
    (Number(r.lop_days) > 0 ? ' (' + r.paid_days + ' paid, ' + r.lop_days + ' Loss of Pay)' : '');

  const person = (empId) => ({ person: Directory.profile(Directory.employee(empId)) });
  const people = (ids) => ids.map(person).filter((p) => p.person);
  const joinPeople = (list) => list.reduce((acc, p, i) => acc.concat(i === 0 ? [p] : [i === list.length - 1 ? ' and ' : ', ', p]), []);

  const approverIds = (r, filter) => r.approvals.filter((a) => a.approver_id !== Directory.SYSTEM && (!filter || filter(a))).map((a) => a.approver_id);
  const pendingIds = (r) => approverIds(r, (a) => a.decision === 'PENDING');

  function fields(r) {
    return [
      { label: 'Employee', value: r.employee.name + (r.employee.team_name ? ' · ' + r.employee.team_name : '') },
      { label: 'Type', value: r.type_name },
      { label: 'Dates', value: dateRange(r) },
      { label: 'Days', value: dayText(r) },
    ];
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
        parts: ['New leave request for '].concat(joinPeople(approvers), [approvers.length > 1 ? '. Either approval is enough.' : '.']),
        comment: r.reason ? 'Reason: ' + r.reason : '',
        recipients: approvers, link: link('approvals', r.req_id),
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
        recipients: people([r.emp_id].concat(pendingIds(r))), link: link('requests', r.req_id),
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
    return Object.assign({ event: event, fields: fields(request), comment: '', badge: '', reqId: request.req_id },
      template(request, actor || {}));
  }

  return { build };
})();
