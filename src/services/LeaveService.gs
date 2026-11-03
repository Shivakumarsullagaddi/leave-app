/**
 * LeaveService.gs — the requester's side: preview, submit, cancel, list.
 * Approver actions live in ApprovalService.
 */
const LeaveService = (() => {
  const requests = () => Db.table('LeaveRequests');
  const ACTIVE = ['PENDING', 'APPROVED'];

  function normalize(input) {
    const i = input || {};
    const start = String(i.start_date || '');
    return {
      type_id: String(i.type_id || ''),
      start_date: start,
      end_date: String(i.end_date || start),
      half_day: i.half_day === true,
      reason: String(i.reason || '').trim().slice(0, 500),
    };
  }

  function validate(emp, req) {
    const type = Catalog.leaveType(req.type_id);
    if (!type || !type.active) throw Errors.invalid('Choose a leave type.');
    if (!DateUtil.isValid(req.start_date) || !DateUtil.isValid(req.end_date)) throw Errors.invalid('Choose valid dates.');
    if (req.end_date < req.start_date) throw Errors.invalid('The end date is before the start date.');
    if (DateUtil.year(req.start_date) !== DateUtil.year(req.end_date)) {
      throw Errors.invalid('Leave can\'t run into the next year. Send one request for each year.');
    }
    if (req.half_day) {
      if (req.start_date !== req.end_date) throw Errors.invalid('A half day starts and ends on the same date.');
      if (!type.half_day_allowed || !Config.bool('HALF_DAY_ALLOWED')) throw Errors.invalid('Half days aren\'t allowed for ' + type.name + '.');
    }
    const clash = requests().find((r) => r.emp_id === emp.emp_id && ACTIVE.indexOf(r.status) !== -1 &&
      DateUtil.overlaps(r.start_date, r.end_date, req.start_date, req.end_date));
    if (clash) throw Errors.conflict('You already have leave on some of these dates (' + clash.req_id + ').');
    return type;
  }

  /** Works out days, paid vs LOP and approvers. Shared by preview and submit. */
  function quote(emp, input) {
    const req = normalize(input);
    const type = validate(emp, req);
    const days = DateUtil.workingDays(req.start_date, req.end_date,
      Object.assign({ halfDay: req.half_day }, Catalog.calendar()));
    if (days <= 0) throw Errors.invalid('These dates are all weekends or holidays, so no leave is needed.');
    const split = BalanceService.split(emp.emp_id, req.type_id, DateUtil.year(req.start_date), days);
    return { req, type, days, paid: split.paid, lop: split.lop, available: split.available, approvers: ApprovalRouter.route(emp) };
  }

  function preview(emp, input) {
    const q = quote(emp, input);
    return {
      days: q.days, paid: q.paid, lop: q.lop, available: q.available, overQuota: q.lop > 0,
      autoApprove: q.approvers.some((a) => a.auto),
      approvers: q.approvers.filter((a) => !a.auto).map((a) => ({ name: Directory.name(a.approver_id), role: a.approver_role })),
    };
  }

  function submit(emp, input) {
    const result = Db.transaction(() => {
      const q = quote(emp, input);
      if (!q.approvers.length) throw Errors.invalid('No approver is set up for your team yet. Ask the admin.');
      const now = DateUtil.now();
      const year = DateUtil.year(q.req.start_date);
      const t = requests();
      const request = t.insert(Object.assign({ req_id: t.nextId('LR-' + year + '-', 4), emp_id: emp.emp_id }, q.req, {
        days: q.days, paid_days: q.paid, lop_days: q.lop, over_quota: q.lop > 0,
        status: 'PENDING', final_by: '', final_at: '', submitted_at: now, cancelled_at: '', updated_at: now,
      }));
      BalanceService.hold(emp.emp_id, request.type_id, year, q.paid);
      ApprovalService.open(request, q.approvers);
      Audit.log({ actor: emp.email, action: 'SUBMIT', entity: 'LeaveRequests', entity_id: request.req_id,
        new_value: q.days + ' day(s), ' + q.lop + ' LOP', reason: request.reason });

      const isAuto = q.approvers.some((a) => a.auto);
      return { request: isAuto ? ApprovalService.autoApprove(request) : request, event: isAuto ? 'AUTO_APPROVED' : 'SUBMITTED' };
    });
    Notifier.publish(result.event, { reqId: result.request.req_id, actorId: emp.emp_id });
    return RequestView.of(result.request);
  }

  function cancel(emp, reqId) {
    const request = Db.transaction(() => {
      const r = requests().get(reqId);
      if (!r || r.emp_id !== emp.emp_id) throw Errors.notFound('Request ' + reqId);
      if (r.status !== 'PENDING') throw Errors.conflict('Only pending requests can be cancelled.');
      const now = DateUtil.now();
      BalanceService.release(r.emp_id, r.type_id, DateUtil.year(r.start_date), Number(r.paid_days) || 0);
      ApprovalService.closeOpen(reqId);
      Audit.log({ actor: emp.email, action: 'CANCEL', entity: 'LeaveRequests', entity_id: reqId,
        field: 'status', old_value: r.status, new_value: 'CANCELLED' });
      return requests().update(reqId, { status: 'CANCELLED', final_by: emp.emp_id, final_at: now, cancelled_at: now, updated_at: now });
    });
    Notifier.publish('CANCELLED', { reqId: reqId, actorId: emp.emp_id });
    return RequestView.of(request);
  }

  function mine(emp) {
    return requests()
      .where((r) => r.emp_id === emp.emp_id)
      .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))
      .map(RequestView.of);
  }

  return { preview, submit, cancel, mine };
})();
