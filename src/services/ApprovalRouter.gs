/**
 * ApprovalRouter.gs — decides WHO approves a request, from the ApprovalFlow tab.
 *
 * Each flow row names a rule. Rules are small strategies in RULES; to support a
 * new kind of approver (e.g. HR), add a rule here and a row in ApprovalFlow.
 * Rows for a specific team override the '*' (all teams) rows for that team.
 */
const ApprovalRouter = (() => {
  const RULES = {
    TEAM_LEAD:   (emp, team) => (team && team.lead_id ? [{ approver_id: team.lead_id, approver_role: 'TEAM_LEAD' }] : []),
    TEAM_CSUITE: (emp, team) => (team && team.csuite_id ? [{ approver_id: team.csuite_id, approver_role: 'CSUITE' }] : []),
    SPECIFIC:    (emp, team, flow) => (flow.approver_id ? [{ approver_id: flow.approver_id, approver_role: 'SPECIFIC' }] : []),
    AUTO:        () => [{ approver_id: Directory.SYSTEM, approver_role: 'SYSTEM', auto: true }],
  };

  function flowsFor(emp) {
    const rows = Db.table('ApprovalFlow').where((f) => f.active && f.requester_role === emp.role_level);
    const teamRows = rows.filter((f) => f.team_id === emp.team_id);
    return teamRows.length ? teamRows : rows.filter((f) => f.team_id === '*');
  }

  /** @returns {Array<{approver_id, approver_role, auto?}>} unique approvers, never the requester. */
  function route(emp) {
    const team = Directory.team(emp.team_id);
    const result = [];
    flowsFor(emp).forEach((flow) => {
      const rule = RULES[flow.approver_rule];
      if (!rule) return;
      rule(emp, team, flow).forEach((a) => {
        const isSelf = a.approver_id === emp.emp_id;
        const isDuplicate = result.some((x) => x.approver_id === a.approver_id);
        if (!isSelf && !isDuplicate) result.push(a);
      });
    });
    return result;
  }

  return { route };
})();
