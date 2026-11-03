/**
 * Api.gs — the only functions the browser calls (via google.script.run).
 *
 * Every call carries the caller's session token first (from Google sign-in).
 * Each endpoint: resolve who is calling → call one service → return plain data.
 * Every response is { ok: true, data } or { ok: false, code, error }.
 * No business rules here.
 */

/** @param {string} session  @param {{view?: string, req?: string}} returnTo */
function apiBootstrap(session, returnTo) {
  return respond_(() => {
    const who = Identity.current(session);
    const base = {
      appName: Config.get('APP_NAME', 'Leave Desk'),
      orgName: Config.get('ORG_NAME', ''),
      today: DateUtil.today(),
      auth: { enabled: Auth.isEnabled(), mode: Auth.mode(), signedIn: !!who.email },
      identity: { email: who.email, isAdmin: who.isAdmin, testMode: who.testMode, viewingAs: who.viewingAs },
      me: who.employee,
    };
    if (Auth.isEnabled() && !who.email) {
      return Object.assign(base, { needsLogin: true },
        Auth.mode() === 'picker' ? { personas: Auth.personas() } : { loginUrl: Auth.loginUrl(returnTo) });
    }
    if (!who.employee) return base;
    const year = DateUtil.year(DateUtil.today());
    return Object.assign(base, {
      isAdmin: who.isAdmin,
      reportScopes: ReportService.scopesFor(who.employee, who.isAdmin),
      people: who.isAdmin && who.testMode ? Directory.activeEmployees().map(Directory.profile) : [],
      leaveTypes: Catalog.leaveTypes().map((t) => ({ type_id: t.type_id, name: t.name, code: t.code, color: t.color, half_day_allowed: t.half_day_allowed })),
      halfDayAllowed: Config.bool('HALF_DAY_ALLOWED'),
      holidays: Catalog.holidays(year).map((h) => ({ date: h.date, name: h.name })),
      balances: BalanceService.summary(who.employee.emp_id, year),
      requests: LeaveService.mine(who.employee),
      inbox: ApprovalService.inbox(who.employee),
    });
  });
}

function apiPreview(session, input) {
  return respond_(() => LeaveService.preview(Identity.requireEmployee(session), input));
}

function apiSubmit(session, input) {
  return respond_(() => LeaveService.submit(Identity.requireEmployee(session), input));
}

function apiCancel(session, reqId) {
  return respond_(() => LeaveService.cancel(Identity.requireEmployee(session), reqId));
}

function apiDecide(session, reqId, decision, comment) {
  return respond_(() => ApprovalService.decide(Identity.requireEmployee(session), reqId, decision, comment));
}

function apiSetViewAs(session, empId) {
  return respond_(() => { Identity.setViewAs(session, empId); return true; });
}

/** Prototype entrance: open a session as one persona (Employee, Intern, Team Lead, CXO, Admin). */
function apiPick(_noSession, persona) {
  return respond_(() => Auth.pick(persona));
}

/** Reports: own, team (leads / C-suite) and organization (admin). scope: person | team | org */
function apiReport(session, scope, id) {
  return respond_(() => {
    const who = Identity.current(session);
    const me = Identity.requireEmployee(session);
    return ReportService.get(me, who.isAdmin, scope || 'person', id || '');
  });
}

/** Admin endpoints. Every one checks the caller is an admin first. */
function requireAdmin_(session) {
  const who = Identity.current(session);
  if (!who.email && Auth.isEnabled()) throw Errors.unauthenticated();
  if (!who.isAdmin) throw Errors.forbidden('Only admins can do this.');
  return who;
}

function apiAdminOverview(session) {
  return respond_(() => { requireAdmin_(session); return AdminService.overview(); });
}

function apiAdminSavePerson(session, input) {
  return respond_(() => Db.transaction(() => AdminService.savePerson(requireAdmin_(session), input)));
}

function apiAdminSaveTeam(session, input) {
  return respond_(() => Db.transaction(() => AdminService.saveTeam(requireAdmin_(session), input)));
}

function apiAdminAdjustBalance(session, empId, typeId, days, reason) {
  return respond_(() => Db.transaction(() => AdminService.adjustBalance(requireAdmin_(session), empId, typeId, days, reason)));
}

function apiAdminSaveQuota(session, ruleId, yearlyQuota) {
  return respond_(() => Db.transaction(() => AdminService.saveQuota(requireAdmin_(session), ruleId, yearlyQuota)));
}

function apiSignOut(session) {
  return respond_(() => { Auth.logout(session); return true; });
}

/** Wraps an endpoint: known problems become friendly messages, the rest are logged. */
function respond_(work) {
  try {
    return { ok: true, data: work() };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, code: e.code, error: e.message };
    console.error(e && e.stack ? e.stack : e);
    return { ok: false, code: 'ERROR', error: 'Something went wrong. Try again, and tell the admin if it keeps happening.' };
  }
}
