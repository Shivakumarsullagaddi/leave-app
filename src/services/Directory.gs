/**
 * Directory.gs — people and teams.
 * profile() is the safe, client-facing shape of an employee.
 */
const Directory = (() => {
  const SYSTEM = 'SYSTEM';
  const lower = (s) => String(s || '').trim().toLowerCase();
  const employees = () => Db.table('Employees');

  const employee = (id) => (id ? employees().get(id) : null);
  const team = (id) => (id ? Db.table('Teams').get(id) : null);
  const activeEmployees = () => employees().where((e) => e.status === 'Active');

  function byEmail(email) {
    const e = lower(email);
    return e ? activeEmployees().find((p) => lower(p.email) === e) || null : null;
  }

  function name(id) {
    if (id === SYSTEM) return 'Leave Desk';
    const e = employee(id);
    return e ? e.name : String(id || '');
  }

  function profile(e) {
    if (!e) return null;
    const t = team(e.team_id);
    return {
      emp_id: e.emp_id, name: e.name, email: e.email, role_level: e.role_level, emp_type: e.emp_type,
      team_id: e.team_id, team_name: t ? t.team_name : '', slack_user_id: e.slack_user_id || '',
    };
  }

  return { SYSTEM, employee, team, activeEmployees, byEmail, name, profile };
})();
