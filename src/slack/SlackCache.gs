/**
 * SlackCache.gs — everything a Slack command needs, kept in CacheService.
 *
 * Slack allows 3 seconds per call and one spreadsheet read costs a good part of that,
 * so the Slack-facing path never reads the sheet: it reads a per-person snapshot
 * (profile, balances, own requests, requests waiting for them) that the background
 * job rewrites after every change and every ten minutes.
 *
 * The refresh also links every active employee to their Slack member ID (by email, in one
 * parallel batch) and caches an email → employee directory, so even a person's very first
 * /leavedesk — or a stranger's — is answered from the cache. Slack IDs are kept in the cache
 * only; they are never written to the sheet (an admin may still type one into slack_user_id).
 *
 * Also kept here, because the Slack path must decide without the sheet:
 *   claims  slack:claim:<req_id>  who decided first in Slack (first click wins), then the final status
 *   cards   SLACK_CARDS_<req_id>  where each approver's card was posted, so all can be closed together
 */
const SlackCache = (() => {
  const TTL = 21600;              // six hours, the CacheService maximum
  const STALE_MS = 10 * 60000;
  const INBOX_MAX = 25;           // keeps a snapshot far below CacheService's 100 KB per value
  const cache = () => CacheService.getScriptCache();
  const props = () => PropertiesService.getScriptProperties();
  const empKey = (id) => 'slack:emp:' + id;
  const userKey = (u) => 'slack:user:' + u;
  const claimKey = (reqId) => 'slack:claim:' + reqId;
  const cardsKey = (reqId) => 'SLACK_CARDS_' + reqId;
  const POLICY = 'slack:decision_lock';

  const EMAILS = 'slack:emails';
  const UNKNOWN = '-';
  const UNKNOWN_TTL = 120;        // a stranger is re-checked after two minutes (the admin may have just added them)

  const snapshot = (empId) => { const v = empId ? cache().get(empKey(empId)) : null; return v ? JSON.parse(v) : null; };
  const empIdForUser = (u) => { const v = cache().get(userKey(u)); return v && v !== UNKNOWN ? v : ''; };
  const linkUser = (u, empId) => cache().put(userKey(u), empId, TTL);
  /** Slack users we just found are not in Employees, so a repeat command costs no Slack call. */
  const markUnknown = (u) => cache().put(userKey(u), UNKNOWN, UNKNOWN_TTL);
  const isUnknown = (u) => cache().get(userKey(u)) === UNKNOWN;
  /** { lower-case email: emp_id } of every active employee, or null when not cached (then only the background job may decide). */
  const emailIndex = () => { const v = cache().get(EMAILS); return v ? JSON.parse(v) : null; };
  const save = (snap) => cache().put(empKey(snap.emp_id), JSON.stringify(snap), TTL);

  /** FIRST_DECISION unless Settings say LEAVE_START; copied into the cache by refresh() so Slack never reads Settings. */
  const firstIsFinal = () => cache().get(POLICY) !== 'LEAVE_START';

  // ------------------------------------------------------------------ claims (first click wins)

  const claimOf = (reqId) => { const v = cache().get(claimKey(reqId)); return v ? JSON.parse(v) : null; };

  /**
   * Records who decided first in Slack. Returns { won, claim }: won = false when someone already
   * decided (claim says who) — the caller then tells the person at once instead of queueing.
   * CacheService has no compare-and-set, so two submits within the same few milliseconds can both
   * pass; the background job still files decisions one at a time, so the data stays deterministic.
   */
  function claim(reqId, who) {
    const existing = claimOf(reqId);
    if (existing) return { won: false, claim: existing };
    cache().put(claimKey(reqId), JSON.stringify(who), TTL);
    return { won: true, claim: who };
  }
  /** The request is final: everyone clicking from now on is told so, without a modal. */
  const settleClaim = (reqId, info) => cache().put(claimKey(reqId), JSON.stringify(Object.assign({ final: true }, info)), TTL);
  /** A queued decision that failed must not keep blocking the other approvers. */
  function releaseClaim(reqId, slackUserId) {
    const c = claimOf(reqId);
    if (c && !c.final && c.slack_user_id === slackUserId) cache().remove(claimKey(reqId));
  }

  // ------------------------------------------------------------------ approver cards

  function rememberCards(reqId, cards) {
    const now = JSON.parse(props().getProperty(cardsKey(reqId)) || '[]');
    props().setProperty(cardsKey(reqId), JSON.stringify(now.concat(cards)));
  }
  function takeCards(reqId) {
    const v = props().getProperty(cardsKey(reqId));
    if (!v) return [];
    props().deleteProperty(cardsKey(reqId));
    return JSON.parse(v);
  }
  /** Requests that still have open approver cards. */
  const openCardRequests = () => Object.keys(props().getProperties ? props().getProperties() : {})
    .filter((k) => k.indexOf('SLACK_CARDS_') === 0).map((k) => k.slice('SLACK_CARDS_'.length));

  // ------------------------------------------------------------------ optimistic update on Send

  /** Shows a just-sent request in the person's snapshot before the job files it (balance: days waiting). */
  function addPending(empId, item, paidDays) {
    const snap = snapshot(empId);
    if (!snap) return;
    snap.requests = [item].concat(snap.requests || []).slice(0, 10);
    snap.balances = (snap.balances || []).map((b) => (b.type_id === item.type_id ? Object.assign({}, b, { pending: (Number(b.pending) || 0) + paidDays }) : b));
    save(snap);
  }

  const markDirty = () => props().setProperty('SLACK_DIRTY', '1');
  function isStale() {
    if (props().getProperty('SLACK_DIRTY')) return true;
    const at = Number(props().getProperty('SLACK_REFRESHED_AT') || 0);
    return Date.now() - at > STALE_MS;
  }

  function brief(r, names, typeName, approvalsByReq) {
    return {
      req_id: r.req_id, emp_id: r.emp_id, employee: names[r.emp_id] || r.emp_id, type: typeName[r.type_id] || r.type_id, type_id: r.type_id,
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

  /**
   * Builds snapshots for the given employees (or everyone active) from one read of each tab.
   * links = { emp_id: Slack ID found by email } (full refresh only); a slack_user_id typed in the sheet wins.
   */
  function build(empIds, links) {
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
    const slackOf = (e) => e.slack_user_id || (links && links[e.emp_id]) || '';
    const entries = {};
    people.forEach((e) => {
      const snap = {
        emp_id: e.emp_id, name: e.name, email: e.email, role_level: e.role_level, emp_type: e.emp_type,
        team: teams[e.team_id] || '', slack_user_id: slackOf(e), year: year, built_at: DateUtil.now(), calendar: calendar,
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
          .sort((a, b) => (a.start_date < b.start_date ? -1 : 1)).slice(0, INBOX_MAX)
          .map((r) => brief(r, names, typeName, approvalsByReq)),
        approvers: approversFor(e, names),
      };
      entries[empKey(e.emp_id)] = JSON.stringify(snap);
      if (slackOf(e)) entries[userKey(slackOf(e))] = e.emp_id;
    });
    if (!empIds) {
      const index = {};
      people.forEach((e) => { if (e.email) index[String(e.email).trim().toLowerCase()] = e.emp_id; });
      entries[EMAILS] = JSON.stringify(index);
    }
    cache().putAll(entries, TTL);
    if (!empIds) {
      forgetMovedLinks(people.map(slackOf).filter(String));
      // Someone who left (or was made inactive) must not keep applying from a six-hour-old snapshot.
      const gone = everyone.filter((e) => e.status !== 'Active');
      if (gone.length) cache().removeAll(gone.map((e) => empKey(e.emp_id)).concat(gone.filter((e) => e.slack_user_id).map((e) => userKey(e.slack_user_id))));
    }
    return people.map((e) => e.emp_id);
  }

  /**
   * Finds the Slack member ID of every active employee with no slack_user_id in the sheet, by work
   * email (one parallel batch; hits and misses are remembered for six hours). Returns { emp_id: ID }.
   * Kept in the cache only — nothing is written to the sheet. Background refresh only.
   */
  function linkByEmail() {
    if (!SlackBot.prop('SLACK_BOT_TOKEN')) return {};
    const active = Directory.activeEmployees();
    const unlinked = active.filter((e) => !e.slack_user_id && e.email);
    if (!unlinked.length) return {};
    const taken = {};
    active.forEach((e) => { if (e.slack_user_id) taken[e.slack_user_id] = true; });
    let ids;
    try { ids = SlackBot.userIdsByEmail(unlinked.map((e) => String(e.email).trim().toLowerCase())); } catch (err) {
      console.error('SlackCache: linking skipped: ' + err.message);
      return {};
    }
    const links = {};
    unlinked.forEach((e) => {
      const id = ids[String(e.email).trim().toLowerCase()];
      if (!id || taken[id]) return;   // not on Slack, or that Slack account already belongs to another row
      taken[id] = true;
      links[e.emp_id] = id;
    });
    return links;
  }

  /** A Slack ID removed from the sheet (or moved to another row) must stop resolving to the old person. */
  function forgetMovedLinks(now) {
    JSON.parse(props().getProperty(LINKED) || '[]').forEach((u) => { if (now.indexOf(u) === -1) cache().remove(userKey(u)); });
    props().setProperty(LINKED, JSON.stringify(now));
  }

  /** Rewrites everyone's snapshot. Called by the background job, never by a Slack request. */
  function refresh() {
    Db.refresh();
    const ids = build(null, linkByEmail());
    cache().put(POLICY, DecisionPolicy.firstIsFinal() ? 'FIRST_DECISION' : 'LEAVE_START', TTL);
    props().deleteProperty('SLACK_DIRTY');
    props().setProperty('SLACK_REFRESHED_AT', String(Date.now()));
    return ids.length;
  }

  /** One person's snapshot straight from the sheet (first contact or evicted cache). */
  function load(empId) {
    build([empId]);
    return snapshot(empId);
  }

  return { snapshot, empIdForUser, linkUser, markUnknown, isUnknown, emailIndex, markDirty, isStale, refresh, load, firstIsFinal, addPending,
    claimOf, claim, settleClaim, releaseClaim, rememberCards, takeCards, openCardRequests };
})();
