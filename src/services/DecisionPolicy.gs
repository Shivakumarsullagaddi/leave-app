/**
 * DecisionPolicy.gs — turns individual approver decisions into a request status.
 *
 * Settings choose the strategy:
 *   APPROVE_RULE  = ANY_ONE (first approval approves) | ALL (everyone must approve)
 *   REJECT_RULE   = ANY_ONE (any rejection rejects)
 *   DECISION_LOCK = FIRST_DECISION (default) the first decision is final: once one approver approves or
 *                                  rejects, the others are closed out and can no longer act.
 *                 | LEAVE_START    an approval can still be overturned by a rejection until the leave starts.
 */
const DecisionPolicy = (() => {
  const isYes = (a) => a.decision === 'APPROVED' || a.decision === 'AUTO';
  const isNo = (a) => a.decision === 'REJECTED';

  const APPROVE_RULES = {
    ANY_ONE: (list) => list.some(isYes),
    ALL:     (list) => list.length > 0 && list.every(isYes),
  };
  const REJECT_RULES = {
    ANY_ONE: (list) => list.some(isNo),
  };

  /** @returns {'PENDING'|'APPROVED'|'REJECTED'} */
  function outcome(approvals) {
    const rejects = REJECT_RULES[Config.get('REJECT_RULE', 'ANY_ONE')] || REJECT_RULES.ANY_ONE;
    const approves = APPROVE_RULES[Config.get('APPROVE_RULE', 'ANY_ONE')] || APPROVE_RULES.ANY_ONE;
    if (rejects(approvals)) return 'REJECTED';
    if (approves(approvals)) return 'APPROVED';
    return 'PENDING';
  }

  /** True unless Settings explicitly keep the old LEAVE_START rule. */
  const firstIsFinal = () => Config.get('DECISION_LOCK', 'FIRST_DECISION') !== 'LEAVE_START';

  /** True when an APPROVED request may no longer be rejected. */
  function isLocked(request) {
    if (firstIsFinal()) return true;
    return DateUtil.today() >= request.start_date;
  }

  /** Can this approver still act on this request? */
  function canAct(request, myApproval) {
    if (!myApproval || myApproval.decision !== 'PENDING') return false;
    if (request.status === 'PENDING') return true;
    return request.status === 'APPROVED' && !isLocked(request);
  }

  return { outcome, isLocked, canAct, firstIsFinal };
})();
