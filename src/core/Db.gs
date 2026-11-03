/**
 * Db.gs — entry point to the database.
 *  Db.table(name)     → Repository for a tab (one instance per execution)
 *  Db.transaction(fn) → runs fn under a script lock with fresh reads, so two
 *                       people approving at the same moment can't corrupt data.
 *
 * In the editor/menus the bound spreadsheet is used. A web app has no "active"
 * spreadsheet, so it opens the one whose id setupDatabase saved in Script Properties.
 */
const Db = (() => {
  const repositories = {};
  let spreadsheet = null;

  function book() {
    if (spreadsheet) return spreadsheet;
    try { spreadsheet = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { spreadsheet = null; }
    if (!spreadsheet) {
      const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
      if (!id) throw Errors.setup('The app is not linked to its spreadsheet yet. Run setupDatabase once from the Apps Script editor.');
      spreadsheet = SpreadsheetApp.openById(id);
    }
    return spreadsheet;
  }

  function table(name) {
    if (!repositories[name]) repositories[name] = Repository(name);
    return repositories[name];
  }

  function refresh() {
    Object.keys(repositories).forEach((k) => repositories[k].invalidate());
  }

  function transaction(work) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) throw Errors.conflict('Leave Desk is busy. Please try again in a few seconds.');
    try {
      refresh();
      const result = work();
      SpreadsheetApp.flush();
      return result;
    } finally {
      lock.releaseLock();
    }
  }

  return { book, table, refresh, transaction };
})();
