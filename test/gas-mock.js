// Minimal in-memory mocks of the Apps Script services the project uses.
// Good enough to run setup + all service flows; formatting calls are no-ops.
const IST = 330 * 60000;
const pad = (n, w = 2) => String(n).padStart(w, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shift(date, tz) { return new Date(date.getTime() + (tz === 'UTC' ? 0 : IST)); }
const crypto = require('crypto');
const Utilities = {
  getUuid: () => crypto.randomUUID(),
  base64DecodeWebSafe: (str) => Array.from(Buffer.from(str, 'base64url')),
  newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
  formatDate(date, tz, fmt) {
    const d = shift(date, tz);
    return fmt
      .replace('yyyy', d.getUTCFullYear()).replace('MMM', MONTHS[d.getUTCMonth()]).replace('MM', pad(d.getUTCMonth() + 1))
      .replace('EEE', DAYS[d.getUTCDay()]).replace('dd', pad(d.getUTCDate())).replace(/\bd\b/, d.getUTCDate())
      .replace('HH', pad(d.getUTCHours())).replace('mm', pad(d.getUTCMinutes()));
  },
  parseDate(str, tz, fmt) {
    const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/);
    if (!m) throw new Error('parseDate: bad ' + str + ' for ' + fmt);
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) - IST);
  },
};

// Chainable no-op for formatting APIs
function noop(target) {
  return new Proxy(target || {}, { get: (t, k) => (k in t ? t[k] : () => noop(t)) });
}

class Sheet {
  constructor(name, book) { this.name = name; this.book = book; this.grid = []; this.maxRows = 1000; this.maxCols = 26; }
  getName() { return this.name; }
  getLastRow() { for (let r = this.grid.length - 1; r >= 0; r--) if ((this.grid[r] || []).some((v) => v !== '' && v !== undefined)) return r + 1; return 0; }
  getLastColumn() { let c = 0; this.grid.forEach((row) => (row || []).forEach((v, j) => { if (v !== '' && v !== undefined) c = Math.max(c, j + 1); })); return c; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  insertColumnsAfter(_, n) { this.maxCols += n; }
  cell(r, c) { return ((this.grid[r - 1] || [])[c - 1]); }
  set(r, c, v) { (this.grid[r - 1] = this.grid[r - 1] || [])[c - 1] = v; }
  getRange(r, c, nr = 1, nc = 1) { return range(this, r, c, nr, nc); }
  getDataRange() { return range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getProtections() { return []; }
  protect() { return noop(); }
  clear() { this.grid = []; }
  getColumnWidth() { return 120; }
}
['setFrozenRows', 'setRowHeight', 'setTabColor', 'autoResizeColumns', 'setColumnWidth'].forEach((m) => { Sheet.prototype[m] = function () { return this; }; });

function range(sheet, r, c, nr, nc) {
  const api = {
    getValues() {
      const out = [];
      for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = sheet.cell(r + i, c + j); row.push(v === undefined ? '' : v); } out.push(row); }
      return out;
    },
    getValue() { const v = sheet.cell(r, c); return v === undefined ? '' : v; },
    setValues(vals) {
      if (vals.length !== nr || vals[0].length !== nc) throw new Error(`setValues size ${vals.length}x${vals[0].length} != ${nr}x${nc}`);
      vals.forEach((row, i) => row.forEach((v, j) => sheet.set(r + i, c + j, v))); return self;
    },
    setValue(v) { sheet.set(r, c, v); return self; },
    clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sheet.set(r + i, c + j, ''); return self; },
    setDataValidation(rule) { // checkboxes fill empty cells with FALSE, like real Sheets
      if (rule && rule.kind === 'checkbox') for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) { const v = sheet.cell(r + i, c + j); if (v === undefined || v === '') sheet.set(r + i, c + j, false); }
      return self;
    },
  };
  const self = noop(api);
  return self;
}

class Book {
  constructor() { this.sheets = [new Sheet('Sheet1', this)]; this.title = 'Untitled'; }
  getId() { return 'BOOK1'; }
  rename(t) { this.title = t; }
  setSpreadsheetTimeZone() {}
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n, this); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
  setActiveSheet(s) { this.active = s; }
  moveActiveSheet(i) { this.sheets = this.sheets.filter((x) => x !== this.active); this.sheets.splice(i - 1, 0, this.active); }
  toast() {}
}

function makeEnv(opts) {
  const book = new Book();
  const props = {};
  const env = { book, mail: [], fetches: [], user: opts.user, today: opts.now, cache: {}, tokenResponse: null };
  const dv = () => { const b = { kind: null }; return new Proxy(b, { get: (t, k) => (k === 'build' ? () => ({ kind: t.kind }) : k === 'requireCheckbox' ? () => { t.kind = 'checkbox'; return p; } : () => p) }); };
  let p;
  const ctx = {
    console, Utilities, Logger: { log: () => {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => (env.webapp ? null : book), openById: () => book, getActive: () => book,
      getUi: () => { throw new Error('no ui'); }, flush() {},
      newDataValidation: () => (p = dv()), ProtectionType: { SHEET: 'SHEET' },
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    Session: { getActiveUser: () => ({ getEmail: () => env.user }) },
    MailApp: { sendEmail: (m) => env.mail.push(m) },
    UrlFetchApp: { fetch: (u, o) => {
      if (u === 'https://oauth2.googleapis.com/token') {
        env.tokenRequests = (env.tokenRequests || []).concat([o.payload]);
        const r = env.tokenResponse || { code: 400, body: '{"error":"invalid_grant"}' };
        return { getResponseCode: () => r.code, getContentText: () => r.body };
      }
      env.fetches.push(JSON.parse(o.payload)); return { getResponseCode: () => 200, getContentText: () => 'ok' }; } },
    HtmlService: {},
    CacheService: { getScriptCache: () => ({
      get: (k) => { const e = env.cache[k]; return e && e.exp > Date.parse(env.today) ? e.v : null; },
      put: (k, v, sec) => { env.cache[k] = { v: String(v), exp: Date.parse(env.today) + sec * 1000 }; },
      remove: (k) => { delete env.cache[k]; } }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }) },
  };
  // Freeze "now" while keeping instanceof Date working
  ctx.Date = new Proxy(Date, {
    construct: (T, a) => (a.length ? new T(...a) : new T(env.today)),
    get: (T, k) => (k === 'now' ? () => Date.parse(env.today) : T[k]),
  });
  return { env, ctx, props };
}
module.exports = { makeEnv };
