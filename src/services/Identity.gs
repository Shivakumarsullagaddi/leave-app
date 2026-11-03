/**
 * Identity.gs — who is using the app.
 *
 * With Google sign-in on (Auth.isEnabled), the email comes from the caller's session.
 * Without it, it falls back to the Google session of the web app (same-domain only).
 * The email is matched to the Employees tab.
 *
 * In TEST_MODE an admin can "view as" another employee; the choice is stored per
 * admin email in Script Properties, so it never affects anyone else.
 */
const Identity = (() => {
  const VIEW_AS_KEY = (email) => 'LD_VIEW_AS:' + email;

  function signedInEmail(session) {
    if (Auth.isEnabled()) return Auth.emailFor(session);
    try { return String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { return ''; }
  }

  const isAdminEmail = (email) => !!email &&
    Config.list('ADMIN_EMAILS').map((s) => s.toLowerCase()).indexOf(email) !== -1;

  function current(session) {
    const email = signedInEmail(session);
    const isAdmin = isAdminEmail(email);
    const testMode = Config.bool('TEST_MODE');
    let viewing = null;
    if (isAdmin && testMode) {
      const id = PropertiesService.getScriptProperties().getProperty(VIEW_AS_KEY(email));
      viewing = id ? Directory.employee(id) : null;
    }
    const person = viewing || Directory.byEmail(email);
    return { email, isAdmin, testMode, viewingAs: !!viewing, employee: Directory.profile(person) };
  }

  /** The employee the request acts for; throws if not signed in or not registered. */
  function requireEmployee(session) {
    const who = current(session);
    if (!who.email && Auth.isEnabled()) throw Errors.unauthenticated();
    if (!who.employee) throw Errors.notRegistered(who.email);
    return who.employee;
  }

  function setViewAs(session, empId) {
    const who = current(session);
    if (!who.email && Auth.isEnabled()) throw Errors.unauthenticated();
    if (!who.isAdmin || !who.testMode) throw Errors.forbidden('"View as" is only for admins while TEST_MODE is on.');
    const props = PropertiesService.getScriptProperties();
    if (!empId) { props.deleteProperty(VIEW_AS_KEY(who.email)); return; }
    if (!Directory.employee(empId)) throw Errors.notFound('Employee ' + empId);
    props.setProperty(VIEW_AS_KEY(who.email), empId);
  }

  return { current, requireEmployee, setViewAs };
})();
