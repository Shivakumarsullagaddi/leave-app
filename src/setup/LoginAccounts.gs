/**
 * LoginAccounts.gs — test logins for Leave Desk (email + password sign-in).
 *
 * ⚠ This file contains passwords. It is listed in .gitignore, so it never goes to
 *   GitHub, but clasp still uploads it to Apps Script. Test accounts only; change
 *   every password before real people use the app.
 *
 * HOW TO USE
 *   1. Edit the list below if you want (passwords: at least 8 characters).
 *   2. In the Apps Script editor, run  setupLoginAccounts  once.
 *   3. Open the web app /exec link and sign in with any account below.
 *   Re-run after any change. Removing an account here and re-running removes its login.
 *
 * Only salted hashes are stored (Script Properties); the app never stores these passwords.
 */
const LOGIN_ACCOUNTS = [
  // Admin: full access + "View as" test bar. Gets its own employee row (E900, C-suite).
  { email: 'admin@leavedesk.test',              password: 'Harbor-1531-Cedar', name: 'Leave Admin', admin: true },

  // Test Team (T-TEST): Employee → Lead + CXO in parallel; Lead → CXO; CXO auto-approved.
  { email: 'shivakumarullagaddi855@gmail.com',  password: 'Meadow-8361-Maple' },   // Test CXO
  { email: 'shivakumarullagaddi56@gmail.com',   password: 'Maple-2729-Harbor' },   // Test Lead
  { email: 'shivakumar.u@darukaa.com',          password: 'Comet-2157-River' },    // Test Employee
];

function setupLoginAccounts() {
  const log = Db.transaction(() => LoginSetup.apply(LOGIN_ACCOUNTS, SetupUi.user()));
  SetupUi.notify('Login accounts ready', log.join('\n'));
}