/**
 * Setup.gs — menu + one-click database setup.
 *
 *  setupDatabase()   Safe: adds missing tabs/columns/settings, re-applies formatting,
 *                    seeds only EMPTY tables, links the web app to this spreadsheet.
 *  resetDatabase()   Wipes all rows and reloads the dummy data (menu only, asks first).
 *  checkDatabase()   Reports missing tabs or columns.
 *  setupTestTeam()   Creates the Test Team for the three test accounts (LD_CONFIG.TEST_ACCOUNTS).
 *
 * Formatting lives in SheetFormatter.gs, dummy data in Seed.gs.
 */

function onOpen() {
  const ui = SetupUi.get();
  if (!ui) return; // run by hand from the editor: nothing to add a menu to
  ui.createMenu('Leave Desk')
    .addItem('Set up database (safe)', 'setupDatabase')
    .addItem('Check database', 'checkDatabase')
    .addItem('Set up prototype (personas + role picker)', 'setupDemo')
    .addItem('Set up test team', 'setupTestTeam')
    .addItem('Check sign-in setup', 'checkSignIn')
    .addSeparator()
    .addItem('Reset to dummy data…', 'resetDatabase')
    .addToUi();
}

function setupDatabase() { SetupEngine.run({ reset: false }); }

function resetDatabase() {
  const ui = SetupUi.get();
  if (!ui) throw new Error('Use "Reset to dummy data…" from the Leave Desk menu in the sheet, so it can ask you first.');
  const answer = ui.alert('Reset Leave Desk data?',
    'This deletes ALL rows in every table and reloads the dummy data. Continue?', ui.ButtonSet.YES_NO);
  if (answer === ui.Button.YES) SetupEngine.run({ reset: true });
}

function checkDatabase() {
  const problems = SetupEngine.check();
  SetupUi.notify('Database check', problems.length ? problems.join('\n')
    : 'All ' + DB_SCHEMA.length + ' tables and their columns are in place.');
  return problems;
}

/**
 * Puts the three test accounts in their own "Test Team" (safe to re-run):
 *   Test Employee → Test Lead + Test CXO (parallel) · Test Lead → Test CXO · Test CXO → auto.
 * Any dummy person still holding a test email gets a placeholder email back.
 */
/**
 * Prototype setup in one go: personas (Employee, Intern, Team Lead, CXO, Admin),
 * their balances, ADMIN_EMAILS, and the role-picker entrance (LOGIN_MODE=PICKER).
 * Safe to re-run.
 */
function setupDemo() {
  const log = Db.transaction(() => {
    const lines = TestTeam.apply(SetupUi.user());
    const admins = LD_CONFIG.TEST_ACCOUNTS.filter((t) => t.admin).map((t) => t.email.toLowerCase()).join(',');
    Db.table('Settings').update('ADMIN_EMAILS', { value: admins });
    lines.push('ADMIN_EMAILS = ' + admins);
    PropertiesService.getScriptProperties().setProperty('LOGIN_MODE', 'PICKER');
    lines.push('Entrance: role picker (' + LD_CONFIG.TEST_ACCOUNTS.map((t) => t.label).join(', ') + ')');
    return lines;
  });
  SetupUi.notify('Prototype ready', log.join('\n'));
}

function setupTestTeam() {
  const done = Db.transaction(() => TestTeam.apply(SetupUi.user()));
  SetupUi.notify('Test team ready', done.join('\n'));
}

const TestTeam = (() => {
  const placeholder = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '') + '@darukaa.com';

  function upsert(table, row, log, actor) {
    const t = Db.table(table);
    const existing = t.get(row[t.idKey]);
    if (existing) t.update(row[t.idKey], row); else t.insert(row);
    Audit.log({ actor: actor, action: existing ? 'UPDATE' : 'CREATE', entity: table, entity_id: row[t.idKey], reason: 'Test team setup' });
    log.push((existing ? 'Updated ' : 'Added ') + table + ' ' + row[t.idKey] + (row.name ? ' · ' + row.name : '') + (row.email ? ' · ' + row.email : ''));
  }

  /** Yearly quota × months active so far this year (whole quarters already credited). */
  function accruedSoFar(person, yearly) {
    const today = DateUtil.today();
    const year = DateUtil.year(today);
    let total = 0;
    for (let q = 1; q <= DateUtil.quarterOf(today); q++) {
      total += roundTo_(yearly * DateUtil.monthsActiveInQuarter(person.join_date, person.end_date, year, q) / 12, 0.5);
    }
    return total;
  }

  function apply(actor) {
    const log = [];
    const now = DateUtil.now();
    const people = testPeople_();
    const testIds = people.map((p) => p.emp_id);
    const employees = Db.table('Employees');

    // 1. Free the test emails from dummy people (e.g. Shiva, Jaya, Guneet).
    people.forEach((p) => {
      employees.where((e) => e.email.toLowerCase() === p.email.toLowerCase() && testIds.indexOf(e.emp_id) === -1).forEach((e) => {
        employees.update(e.emp_id, { email: placeholder(e.name), updated_at: now });
        Audit.log({ actor: actor, action: 'UPDATE', entity: 'Employees', entity_id: e.emp_id, field: 'email',
          old_value: e.email, new_value: placeholder(e.name), reason: 'Test email moved to Test Team' });
        log.push(e.name + ' (' + e.emp_id + ') email reset to ' + placeholder(e.name));
      });
    });

    // 2. People first (no team, no manager), then the team, then link them. The sheet's
    //    dropdowns only accept ids that already exist, so the order matters.
    const person = (p, extra) => Object.assign({
      emp_id: p.emp_id, name: p.name, email: p.email, role_level: p.role_level, emp_type: p.emp_type,
      policy_id: p.policy_id, join_date: p.join_date, end_date: p.end_date, contract_months: p.contract_months,
      slack_user_id: '', status: 'Active', updated_at: now,
    }, extra);
    people.forEach((p) => {
      const existing = employees.get(p.emp_id);
      upsert('Employees', person(p, existing ? {} : { team_id: '', manager_id: '', created_at: now }), log, actor);
    });
    const team = LD_CONFIG.TEST_TEAM;
    upsert('Teams', { team_id: team.team_id, team_name: team.team_name, lead_id: testLead_(), csuite_id: testCxo_(),
      slack_channel: '#leave-requests', active: true, created_at: now }, log, actor);
    people.forEach((p) => employees.update(p.emp_id, { team_id: p.team_id, manager_id: p.manager_id }));

    // 3. Balances for this year (only if missing, so test usage is kept).
    const year = DateUtil.year(DateUtil.today());
    const balances = Db.table('LeaveBalances');
    people.forEach((p) => {
      Db.table('Policies').where((r) => r.policy_id === p.policy_id && r.active).forEach((rule) => {
        if (balances.find((b) => b.emp_id === p.emp_id && b.type_id === rule.type_id && Number(b.year) === year)) return;
        const accrued = accruedSoFar(p, Number(rule.yearly_quota));
        balances.insert({ bal_id: balances.nextId('B', 4), emp_id: p.emp_id, year: year, type_id: rule.type_id,
          accrued: accrued, adjusted: 0, used: 0, pending: 0, available: accrued,
          last_accrual: year + '-Q' + DateUtil.quarterOf(DateUtil.today()), updated_at: now });
        log.push('Balance ' + p.name + ' ' + rule.type_id + ': ' + accrued + ' days');
      });
    });
    return log;
  }

  return { apply };
})();

/**
 * Reports how people sign in, and what is still missing. Run from the editor or the Leave Desk menu.
 *  - Built-in mode (no OAuth keys): Google signs people in; deploy as "User accessing the web app".
 *  - OAuth mode (both keys set): our own "Sign in with Google"; deploy as "Me" + "Anyone".
 */
function checkSignIn() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('OAUTH_CLIENT_ID') || '';
  const secret = props.getProperty('OAUTH_CLIENT_SECRET') || '';
  const appUrl = Config.get('APP_URL');
  const urlOk = /\/exec$/.test(appUrl);
  const urlLine = (urlOk ? '✔' : '✘') + ' APP_URL ' + (appUrl || 'empty') +
    (urlOk ? '' : ' → paste the /exec Web app URL (Settings tab or Script Properties)');
  let lines;
  if (Auth.mode() === 'picker') {
    lines = [
      'Mode: prototype role picker (LOGIN_MODE = PICKER). No passwords.',
      '• Entrance buttons: ' + LD_CONFIG.TEST_ACCOUNTS.map((t) => t.label + ' → ' + t.name).join(', '),
      '• Deployment must be: Execute as = Me; Who has access = Anyone. No Sheet sharing needed.',
      urlLine + (urlOk ? '' : ' (only needed for "Open request" links in emails)'),
      'Sign-in is ON. Open the /exec URL and pick a role.',
    ];
  } else if (!id && !secret) {
    lines = [
      'Mode: Google built-in sign-in (no OAuth keys set).',
      '• Deployment must be: Execute as = User accessing the web app; Who has access = Anyone with Google account.',
      '• Share this Google Sheet as Editor with every person who uses the app.',
      urlLine + (urlOk ? '' : ' (only needed for "Open request" links in emails)'),
      'Sign-in is ON (Google asks each person to sign in and allow the app the first time).',
    ];
  } else {
    lines = [
      'Mode: OAuth "Sign in with Google" (keys found).',
      (id ? '✔' : '✘') + ' OAUTH_CLIENT_ID ' + (id ? 'set (' + id.slice(0, 12) + '…)' : 'missing'),
      (secret ? '✔' : '✘') + ' OAUTH_CLIENT_SECRET ' + (secret ? 'set' : 'missing'),
      urlLine,
      'Google Cloud → Clients → Authorized redirect URI must be exactly: ' + (appUrl || '(APP_URL)'),
      id && secret && urlOk ? 'Sign-in is ON. Open the /exec URL to see "Sign in with Google".'
        : 'Sign-in is OFF until the ✘ items are fixed (or delete both OAuth keys to use built-in sign-in).',
    ];
  }
  SetupUi.notify('Sign-in setup', lines.join('\n'));
  return lines;
}

/* -------------------------------------------------------------------------- */

const SetupEngine = (() => {
  function boundSpreadsheet() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) throw new Error('This Apps Script project is not attached to a Google Sheet. ' +
      'Open the sheet → Extensions → Apps Script and run setupDatabase there.');
    return ss;
  }

  function run(opts) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const ss = boundSpreadsheet();
      ss.rename(LD_CONFIG.SPREADSHEET_TITLE);
      ss.setSpreadsheetTimeZone(LD_CONFIG.TIMEZONE);
      PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
      ensureSecretPlaceholders();

      const seed = buildSeed_(DateUtil.now());
      const summary = DB_SCHEMA.map((table) => prepareTable(ss, table, seed[table.name], opts.reset));
      DB_SCHEMA.forEach((table) => SheetFormatter.style(ss, ss.getSheetByName(table.name), table));
      SheetFormatter.writeReadme(ss);
      SheetFormatter.orderTabs(ss);
      SheetFormatter.removeEmptyTabs(ss);

      Db.refresh();
      Audit.log({ actor: SetupUi.user(), action: 'SETUP', entity: 'ALL', entity_id: 'ALL',
        new_value: 'DB v' + LD_CONFIG.DB_VERSION, reason: opts.reset ? 'Reset to dummy data' : 'Setup run' });

      SpreadsheetApp.flush();
      ss.setActiveSheet(ss.getSheetByName('README'));
      SetupUi.notify('Leave Desk database ready', summary.join('\n'));
    } finally {
      lock.releaseLock();
    }
  }

  /** Creates the tab if needed, adds missing columns, then seeds it (or tops up Settings keys). */
  function prepareTable(ss, table, seedRows, reset) {
    let sheet = ss.getSheetByName(table.name);
    const created = !sheet;
    if (!sheet) sheet = ss.insertSheet(table.name);
    SheetTools.ensureRows(sheet, LD_CONFIG.VALIDATION_ROWS + 1);
    const added = SheetTools.ensureHeaders(sheet, table);
    SheetFormatter.applyNumberFormats(sheet, table);
    if (reset) SheetTools.clearData(sheet);

    let seeded = 0;
    if (seedRows) {
      const empty = SheetTools.lastDataRow(sheet) < 2;
      const rows = empty ? seedRows : missingOnly(sheet, table, seedRows);
      seeded = SheetTools.append(sheet, table, rows);
    }
    return table.name + (created ? ' (new)' : '') +
      (added.length ? ' · new columns: ' + added.join(', ') : '') +
      (seeded ? ' · ' + seeded + ' rows added' : '');
  }

  /** For tables that are already filled, only Settings gets new keys topped up. */
  function missingOnly(sheet, table, seedRows) {
    if (table.name !== 'Settings') return [];
    const idKey = table.columns[0].name;
    const existing = SheetTools.readIds(sheet);
    return seedRows.filter((r) => existing.indexOf(String(r[idKey])) === -1);
  }

  function ensureSecretPlaceholders() {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('SLACK_WEBHOOK_URL') === null) props.setProperty('SLACK_WEBHOOK_URL', '');
  }

  function check() {
    const ss = boundSpreadsheet();
    const problems = [];
    DB_SCHEMA.forEach((t) => {
      const sh = ss.getSheetByName(t.name);
      if (!sh) { problems.push('Missing tab: ' + t.name); return; }
      const headers = SheetTools.readHeaders(sh);
      t.columns.forEach((c) => { if (headers.indexOf(c.name) === -1) problems.push(t.name + ': missing column "' + c.name + '"'); });
    });
    return problems;
  }

  return { run, check };
})();

/* -------------------------------------------------------------------------- */

/** Low-level sheet helpers used only by setup. */
const SheetTools = (() => {
  function readHeaders(sh) {
    const lastCol = sh.getLastColumn();
    return lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h).trim()) : [];
  }

  function ensureRows(sh, rows) {
    const max = sh.getMaxRows();
    if (max < rows) sh.insertRowsAfter(max, rows - max);
  }

  /** New tab: writes headers. Existing tab: appends missing columns at the end. */
  function ensureHeaders(sh, table) {
    const wanted = table.columns.map((c) => c.name);
    const existing = readHeaders(sh);
    const missing = existing.filter(String).length ? wanted.filter((n) => existing.indexOf(n) === -1) : wanted;
    if (!missing.length) return [];
    const start = existing.filter(String).length ? existing.length + 1 : 1;
    const need = start + missing.length - 1;
    if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
    sh.getRange(1, start, 1, missing.length).setValues([missing]);
    return start === 1 ? [] : missing;
  }

  /** Header names in sheet order, each paired with its schema column. */
  function columns(sh, table) {
    const byName = {};
    table.columns.forEach((c) => { byName[c.name] = c; });
    return readHeaders(sh).map((h) => byName[h] || { name: h, type: 'text' });
  }

  function readIds(sh) {
    const last = sh.getLastRow();
    return last < 2 ? [] : sh.getRange(2, 1, last - 1, 1).getValues().map((r) => String(r[0])).filter(String);
  }

  /** Last row whose first column (the id) is filled. Checkbox columns make getLastRow() unreliable. */
  function lastDataRow(sh) {
    const last = sh.getLastRow();
    if (last < 2) return 1;
    const ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) if (ids[i][0] !== '' && ids[i][0] !== null) return i + 2;
    return 1;
  }

  function clearData(sh) {
    const last = sh.getLastRow();
    if (last > 1 && sh.getLastColumn() > 0) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
  }

  function append(sh, table, objects) {
    if (!objects || !objects.length) return 0;
    const cols = columns(sh, table);
    const values = objects.map((o) => cols.map((c) => Codec.toCell(o[c.name], c.type)));
    sh.getRange(lastDataRow(sh) + 1, 1, values.length, cols.length).setValues(values);
    return values.length;
  }

  return { readHeaders, ensureRows, ensureHeaders, columns, readIds, lastDataRow, clearData, append };
})();

/* -------------------------------------------------------------------------- */

/** Dialogs work from the sheet menu; from the editor we fall back to the log. */
const SetupUi = (() => {
  function get() { try { return SpreadsheetApp.getUi(); } catch (e) { return null; } }
  function user() { try { return Session.getActiveUser().getEmail() || 'system'; } catch (e) { return 'system'; } }
  function notify(title, message) {
    Logger.log(title + '\n' + message);
    const ui = get();
    if (ui) { try { ui.alert(title, message, ui.ButtonSet.OK); return; } catch (e) { /* editor run */ } }
    try { SpreadsheetApp.getActiveSpreadsheet().toast(message.slice(0, 250), title, 8); } catch (e) { /* ignore */ }
  }
  return { get, user, notify };
})();
