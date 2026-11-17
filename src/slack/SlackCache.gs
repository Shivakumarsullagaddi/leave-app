/**
 * SlackCache.gs — everything a Slack command needs, kept in CacheService.
 *
 * Slack allows 3 seconds per call and one spreadsheet read costs a good part of that,
 * so the Slack-facing path never reads the sheet: it reads a per-person snapshot
 * (profile, balances, own requests, requests waiting for them) that the background
 * job rewrites after every change and every ten minutes.
 */
const SlackCache = (() => {
  const TTL = 21600;              // six hours, the CacheService maximum
  const STALE_MS = 10 * 60000;
  const cache = () => CacheService.getScriptCache();
  const props = () => PropertiesService.getScriptProperties();
  const empKey = (id) => 'slack:emp:' + id;
  const userKey = (u) => 'slack:user:' + u;

  const snapshot = (empId) => { const v = empId ? cache().get(empKey(empId)) : null; return v ? JSON.parse(v) : null; };
  const empIdForUser = (u) => cache().get(userKey(u)) || '';
  const linkUser = (u, empId) => cache().put(userKey(u), empId, TTL);

  const markDirty = () => props().setProperty('SLACK_DIRTY', '1');
  function isStale() {
    if (props().getProperty('SLACK_DIRTY')) return true;
    const at = Number(props().getProperty('SLACK_REFRESHED_AT') || 0);
    return Date.now() - at > STALE_MS;
  }

  function brief(r, names, typeName, approvalsByReq) {
    return {
      req_id: r.req_id, emp_id: r.emp_id, employee: names[r.emp_id] || r.emp_id, type: typeName[r.type_id] || r.type_id,
      start_date: r.start_date, end_date: r.end_date, days: Number(r.days) || 0, lop: Number(r.lop_days) || 0,
      status: r.status, reason: r.reason || '', submitted_at: r.submitted_at || '',
      approvers: (approvalsByReq[r.req_id] || []).filter((a) => a.approver_id !== Directory.SYSTEM)
        .map((a) => ({ name: names[a.approver_id] || a.approver_id, role: a.approver_role, decision: a.decision, decided_at: a.decided_at || '' })),
    };
  }

  const LINKED = 'SLACK_LINKED_USERS';

  /** Who a new request from this person goes to, so Slack can show it before anything is filed. */
  function approversFor(e, names) {
    try {
      return ApprovalRouter.route(e).map((a) => (a.auto ? { auto: true } : { name: names[a.approver_id] || a.approver_id, role: a.approver_role, decision: 'PENDING' }));
    } catch (err) {
      console.error('SlackCache: approvers for ' + e.emp_id + ': ' + err);
      return [];
    }
  }

  /** Builds snapshots for the given employees (or everyone active) from one read of each tab. */
  function build(empIds) {
    const year = DateUtil.year(DateUtil.today());
    const calendar = Catalog.calendar();
    const types = Catalog.leaveTypes();
    const typeName = {};
    types.forEach((t) => { typeName[t.type_id] = t.name; });
    const teams = {};
    Db.table('Teams').all().forEach((t) => { teams[t.team_id] = t.team_name; });
    const everyone = Db.table('Employees').all();
    const names = {};
    everyone.forEach((e) => { names[e.emp_id] = e.name; });
    const balances = Db.table('LeaveBalances').where((b) => Number(b.year) === year);
    const requests = Db.table('LeaveRequests').where((r) => DateUtil.year(r.start_date) === year);
    const approvalsByReq = {};
    Db.table('Approvals').all().forEach((a) => { (approvalsByReq[a.req_id] = approvalsByReq[a.req_id] || []).push(a); });

    const people = everyone.filter((e) => e.status === 'Active' && (!empIds || empIds.indexOf(e.emp_id) !== -1));
    const entries = {};
    people.forEach((e) => {
      const snap = {
        emp_id: e.emp_id, name: e.name, email: e.email, role_level: e.role_level, emp_type: e.emp_type,
        team: teams[e.team_id] || '', slack_user_id: e.slack_user_id || '', year: year, built_at: DateUtil.now(), calendar: calendar,
        balances: types.map((t) => {
          const b = balances.find((x) => x.emp_id === e.emp_id && x.type_id === t.type_id) || {};
          const n = (v) => Number(v) || 0;
          return { type_id: t.type_id, name: t.name, code: t.code, quota: n(b.accrued) + n(b.adjusted),
            used: n(b.used), pending: n(b.pending), available: n(b.accrued) + n(b.adjusted) - n(b.used) };
        }),
        requests: requests.filter((r) => r.emp_id === e.emp_id)
          .sort((a, b) => (a.start_date < b.start_date ? 1 : -1)).slice(0, 10)
          .map((r) => brief(r, names, typeName, approvalsByReq)),
        inbox: requests.filter((r) => (approvalsByReq[r.req_id] || []).some((a) => a.approver_id === e.emp_id && DecisionPolicy.canAct(r, a)))
          .sort((a, b) => (a.start_date < b.start_date ? -1 : 1))
          .map((r) => brief(r, names, typeName, approvalsByReq)),
        approvers: approversFor(e, names),
      };
      entries[empKey(e.emp_id)] = JSON.stringify(snap);
      if (e.slack_user_id) entries[userKey(e.slack_user_id)] = e.emp_id;
    });
    cache().putAll(entries, TTL);
    if (!empIds) forgetMovedLinks(people);
    return people.map((e) => e.emp_id);
  }

  /** A Slack ID removed from the sheet (or moved to another row) must stop resolving to the old person. */
  function forgetMovedLinks(people) {
    const now = people.map((e) => e.slack_user_id).filter(String);
    JSON.parse(props().getProperty(LINKED) || '[]').forEach((u) => { if (now.indexOf(u) === -1) cache().remove(userKey(u)); });
    props().setProperty(LINKED, JSON.stringify(now));
  }

  /** Rewrites everyone's snapshot. Called by the background job, never by a Slack request. */
  function refresh() {
    Db.refresh();
    const ids = build(null);
    props().deleteProperty('SLACK_DIRTY');
    props().setProperty('SLACK_REFRESHED_AT', String(Date.now()));
    return ids.length;
  }

  /** One person's snapshot straight from the sheet (first contact or evicted cache). */
  function load(empId) {
    build([empId]);
    return snapshot(empId);
  }

  return { snapshot, empIdForUser, linkUser, markDirty, isStale, refresh, load };
})();
