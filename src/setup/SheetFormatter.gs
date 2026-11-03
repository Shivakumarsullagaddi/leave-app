/**
 * SheetFormatter.gs — how the database tabs look and what they accept:
 * header style + notes, date/ID formats, dropdowns, checkboxes, protection, README tab.
 */
const SheetFormatter = (() => {
  const FORMATS = { id: '@', date: 'yyyy-mm-dd', datetime: 'yyyy-mm-dd hh:mm' };

  function applyNumberFormats(sheet, table) {
    SheetTools.columns(sheet, table).forEach((c, i) => {
      if (FORMATS[c.type]) sheet.getRange(2, i + 1, LD_CONFIG.VALIDATION_ROWS, 1).setNumberFormat(FORMATS[c.type]);
    });
  }

  /** Builds the data-validation rule for one column, or null for free text. */
  function ruleFor(ss, column) {
    const dv = SpreadsheetApp.newDataValidation();
    switch (column.type) {
      case 'bool':     return dv.requireCheckbox().build();
      case 'enum':     return column.values ? dv.requireValueInList(column.values, true).setAllowInvalid(false).build() : null;
      case 'email':    return dv.requireTextIsEmail().setAllowInvalid(true).build();
      case 'date':
      case 'datetime': return dv.requireDate().setAllowInvalid(true).build();
      case 'ref': {
        const parts = String(column.ref || '').split('.');
        const target = ss.getSheetByName(parts[0]);
        const idx = target ? SheetTools.readHeaders(target).indexOf(parts[1]) : -1;
        if (idx === -1) return null;
        return dv.requireValueInRange(target.getRange(2, idx + 1, LD_CONFIG.VALIDATION_ROWS, 1), true).setAllowInvalid(false).build();
      }
      default:         return null;
    }
  }

  function style(ss, sheet, table) {
    const cols = SheetTools.columns(sheet, table);
    const n = cols.length;

    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, n)
      .setBackground(LD_CONFIG.HEADER_BG).setFontColor(LD_CONFIG.HEADER_FG)
      .setFontWeight('bold').setVerticalAlignment('middle')
      .setNotes([cols.map((c) => c.note || '')]);
    sheet.setRowHeight(1, 30);
    sheet.setTabColor(TAB_COLORS[table.group] || null);

    cols.forEach((c, i) => sheet.getRange(2, i + 1, LD_CONFIG.VALIDATION_ROWS, 1).setDataValidation(ruleFor(ss, c)));

    sheet.autoResizeColumns(1, n);
    for (let i = 1; i <= n; i++) {
      const w = sheet.getColumnWidth(i);
      if (w < 90) sheet.setColumnWidth(i, 90);
      if (w > 340) sheet.setColumnWidth(i, 340);
    }
    protect(sheet, table);
  }

  /** App-managed tabs warn before a hand edit (the app itself is never blocked). */
  function protect(sheet, table) {
    sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach((p) => {
      if (p.getDescription() === LD_CONFIG.PROTECT_TAG) p.remove();
    });
    if (table.group === 'txn' || table.group === 'log') {
      sheet.protect().setDescription(LD_CONFIG.PROTECT_TAG).setWarningOnly(true);
    }
  }

  function writeReadme(ss) {
    const sheet = ss.getSheetByName('README') || ss.insertSheet('README');
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
    sheet.clear();
    const rows = [
      [LD_CONFIG.APP_NAME + ' – Database', '', ''],
      ['Leave management for ' + LD_CONFIG.ORG_NAME + '. Each tab below is one table. Row 1 = column names (hover a header for its meaning).', '', ''],
      ['', '', ''],
      ['Tab', 'What it stores', 'Edited by'],
    ].concat(DB_SCHEMA.map((t) => [t.name, t.purpose, t.editedBy])).concat([
      ['', '', ''],
      ['Rules', 'Employee leave → Team Lead + team C-suite in parallel. First approval approves; any rejection rejects (until the leave starts).', ''],
      ['', 'Team lead leave → their team\'s C-suite. C-suite leave → auto-approved and logged.', ''],
      ['', 'Full-time: 20 Paid + 12 Sick per year, credited 5 + 3 each quarter. Interns/contractors: prorated by months in contract.', ''],
      ['', 'Over quota is allowed with a warning; extra days are Loss of Pay. Unused leave expires at year end (no carry-forward).', ''],
      ['', 'Do not hand-edit LeaveRequests, Approvals, LeaveBalances or AuditLog. Use the app.', ''],
      ['', '', ''],
      ['DB version', String(LD_CONFIG.DB_VERSION), ''],
      ['Last setup', DateUtil.now(), ''],
    ]);
    sheet.getRange(1, 1, rows.length, 3).setValues(rows).setVerticalAlignment('top').setWrap(true);
    sheet.getRange(1, 1).setFontSize(16).setFontWeight('bold').setFontColor(LD_CONFIG.HEADER_BG);
    sheet.getRange(2, 1, 1, 3).merge().setFontColor('#56675F');
    sheet.getRange(4, 1, 1, 3).setBackground(LD_CONFIG.HEADER_BG).setFontColor(LD_CONFIG.HEADER_FG).setFontWeight('bold');
    sheet.getRange(5, 1, DB_SCHEMA.length, 1).setFontWeight('bold');
    sheet.getRange(6 + DB_SCHEMA.length, 1).setFontWeight('bold');
    sheet.setColumnWidth(1, 150);
    sheet.setColumnWidth(2, 620);
    sheet.setColumnWidth(3, 230);
    sheet.setTabColor(TAB_COLORS.readme);
  }

  function orderTabs(ss) {
    ['README'].concat(DB_SCHEMA.map((t) => t.name)).forEach((name, i) => {
      const sheet = ss.getSheetByName(name);
      if (!sheet) return;
      ss.setActiveSheet(sheet);
      ss.moveActiveSheet(i + 1);
    });
  }

  /** Deletes empty leftovers like "Sheet1". Never deletes a tab with content. */
  function removeEmptyTabs(ss) {
    const keep = ['README'].concat(DB_SCHEMA.map((t) => t.name));
    ss.getSheets().forEach((sheet) => {
      const empty = sheet.getLastRow() === 0 && sheet.getLastColumn() === 0;
      if (keep.indexOf(sheet.getName()) === -1 && empty && ss.getSheets().length > 1) ss.deleteSheet(sheet);
    });
  }

  return { applyNumberFormats, style, writeReadme, orderTabs, removeEmptyTabs };
})();
