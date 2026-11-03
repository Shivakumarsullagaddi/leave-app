/**
 * RequestView.gs — builds the client-facing shape of a leave request
 * (request + requester + leave type + every approver's decision, in time order).
 */
const RequestView = (() => {
  function approvalsOf(reqId) {
    return Db.table('Approvals')
      .where((a) => a.req_id === reqId)
      .map((a) => ({
        appr_id: a.appr_id, approver_id: a.approver_id, name: Directory.name(a.approver_id),
        role: a.approver_role, decision: a.decision, comment: a.comment, decided_at: a.decided_at,
      }))
      .sort((a, b) => (a.decided_at || '9999') < (b.decided_at || '9999') ? -1 : 1);
  }

  function of(request) {
    const type = Catalog.leaveType(request.type_id);
    return Object.assign({}, request, {
      employee: Directory.profile(Directory.employee(request.emp_id)),
      type_name: type ? type.name : request.type_id,
      type_color: type ? type.color : '',
      final_by_name: request.final_by ? Directory.name(request.final_by) : '',
      approvals: approvalsOf(request.req_id),
    });
  }

  const byId = (reqId) => {
    const r = Db.table('LeaveRequests').get(reqId);
    return r ? of(r) : null;
  };

  return { of, byId };
})();
