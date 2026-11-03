/**
 * ApprovalService.gs — the approver's side.
 *
 * All approvers of a request get a row in Approvals at the same time (parallel).
 * After each decision, DecisionPolicy works out the request status and the
 * balance moves to match. Every decision keeps its own timestamp.
 */
const ApprovalService = (() => {
  const approvals = () => Db.table('Approvals');
  const requests = () => Db.table('LeaveRequests');
  const forRequest = (reqId) => approvals().where((a) => a.req_id === reqId);

  /** Creates one PENDING row per approver. */
  function open(request, approvers) {
    const t = approvals();
    const now = DateUtil.now();
    approvers.forEach((a) => t.insert({
      appr_id: t.nextId('A', 4), req_id: request.req_id, approver_id: a.approver_id, approver_role: a.approver_role,
      decision: 'PENDING', comment: '', notified_at: now, decided_at: '',
    }));
  }

  /** Marks every still-pending row as NO_ACTION (request closed without them). */
  function closeOpen(reqId) {
    forRequest(reqId).filter((a) => a.decision === 'PENDING')
      .forEach((a) => approvals().update(a.appr_id, { decision: 'NO_ACTION' }));
  }

  function autoApprove(request) {
    const row = forRequest(request.req_id).find((a) => a.approver_id === Directory.SYSTEM);
    approvals().update(row.appr_id, { decision: 'AUTO', comment: 'C-suite auto-approval', decided_at: DateUtil.now() });
    return applyOutcome(request, { emp_id: Directory.SYSTEM, email: 'system' }, 'AUTO_APPROVE');
  }

  /** Recomputes the request status and moves the balance to match. */
  function applyOutcome(request, actor, action) {
    const next = DecisionPolicy.outcome(forRequest(request.req_id));
    if (next === request.status) return request;

    const year = DateUtil.year(request.start_date);
    const paid = Number(request.paid_days) || 0;
    const move = {
      'PENDING>APPROVED':  BalanceService.commit,
      'PENDING>REJECTED':  BalanceService.release,
      'APPROVED>REJECTED': BalanceService.revert,
    }[request.status + '>' + next];
    if (move) move(request.emp_id, request.type_id, year, paid);
    if (next === 'REJECTED') closeOpen(request.req_id);

    Audit.log({ actor: actor.email, action: action || (next === 'APPROVED' ? 'APPROVE' : 'REJECT'),
      entity: 'LeaveRequests', entity_id: request.req_id, field: 'status', old_value: request.status, new_value: next });
    const now = DateUtil.now();
    return requests().update(request.req_id, { status: next, final_by: actor.emp_id, final_at: now, updated_at: now });
  }

  /** Which notification a decision triggers. */
  function eventFor(before, after, decision) {
    if (before !== after) return after;                 // 'APPROVED' or 'REJECTED'
    return decision === 'APPROVED' ? 'APPROVAL_ADDED' : null;
  }

  function decide(approver, reqId, decision, comment) {
    if (decision !== 'APPROVED' && decision !== 'REJECTED') throw Errors.invalid('Choose Approve or Reject.');
    const note = String(comment || '').trim().slice(0, 500);
    if (decision === 'REJECTED' && !note) throw Errors.invalid('Add a short reason when you reject.');

    const out = Db.transaction(() => {
      const request = requests().get(reqId);
      if (!request) throw Errors.notFound('Request ' + reqId);
      const mine = forRequest(reqId).find((a) => a.approver_id === approver.emp_id);
      if (!mine) throw Errors.forbidden('You are not an approver for this request.');
      if (mine.decision !== 'PENDING') throw Errors.conflict('You have already responded to this request.');
      if (request.status === 'REJECTED' || request.status === 'CANCELLED') {
        throw Errors.conflict('This request is already ' + request.status.toLowerCase() + '.');
      }
      if (request.status === 'APPROVED' && decision === 'REJECTED' && DecisionPolicy.isLocked(request)) {
        throw Errors.conflict('This leave has already started, so it can no longer be rejected.');
      }

      approvals().update(mine.appr_id, { decision: decision, comment: note, decided_at: DateUtil.now() });
      Audit.log({ actor: approver.email, action: decision === 'APPROVED' ? 'APPROVE' : 'REJECT', entity: 'Approvals',
        entity_id: mine.appr_id, field: 'decision', old_value: 'PENDING', new_value: decision, reason: note });

      const updated = applyOutcome(request, approver);
      return { request: updated, event: eventFor(request.status, updated.status, decision) };
    });
    Notifier.publish(out.event, { reqId: reqId, actorId: approver.emp_id });
    return RequestView.of(out.request);
  }

  /** Requests waiting for this approver, plus the ones they recently decided. */
  function inbox(approver) {
    const byId = {};
    requests().all().forEach((r) => { byId[r.req_id] = r; });
    const waiting = [];
    const decided = [];
    approvals().where((a) => a.approver_id === approver.emp_id).forEach((a) => {
      const r = byId[a.req_id];
      if (!r) return;
      if (DecisionPolicy.canAct(r, a)) waiting.push(r);
      else if (a.decision === 'APPROVED' || a.decision === 'REJECTED') decided.push(Object.assign({ _decided_at: a.decided_at }, r));
    });
    const withBalance = (r) => Object.assign(RequestView.of(r), {
      requester_balance: BalanceService.summary(r.emp_id, DateUtil.year(r.start_date)).find((b) => b.type_id === r.type_id) || null,
    });
    return {
      waiting: waiting.sort((a, b) => (a.start_date < b.start_date ? -1 : 1)).map(withBalance),
      decided: decided.sort((a, b) => (a._decided_at < b._decided_at ? 1 : -1)).slice(0, 30).map((r) => {
        delete r._decided_at;
        return RequestView.of(r);
      }),
    };
  }

  return { open, closeOpen, autoApprove, decide, inbox };
})();
