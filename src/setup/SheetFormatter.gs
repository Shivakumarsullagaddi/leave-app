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

  /** Pill colours for enum values: background, text. */
  const BADGE = {
    PENDING:   ['#FFF1CC', '#8A5A00'], APPROVED: ['#D9F2E3', '#1E6B3A'], AUTO: ['#D9F2E3', '#1E6B3A'],
    REJECTED:  ['#FADBD8', '#A02820'], CANCELLED: ['#E8ECEA', '#5B6660'], NO_ACTION: ['#E8ECEA', '#5B6660'],
    Active:    ['#D9F2E3', '#1E6B3A'], Inactive: ['#E8ECEA', '#5B6660'],
    CSUITE:    ['#E6E3F7', '#4B3F9E'], LEAD: ['#DCEBFA', '#1F4F8A'], EMPLOYEE: ['#EEF2F0', '#3C4A44'],
    FT:        ['#EEF2F0', '#3C4A44'], INT: ['#FFF1CC', '#8A5A00'], CON: ['#FBE3CF', '#8A4A10'],
    APPROVE:   ['#D9F2E3', '#1E6B3A'], REJECT: ['#FADBD8', '#A02820'], CANCEL: ['#E8ECEA', '#5B6660'],
    SUBMIT:    ['#DCEBFA', '#1F4F8A'], ADJUST: ['#E6E3F7', '#4B3F9E'],
  };
  const BODY_FG = '#14201B';
  const BAND_ALT = '#F3F7F5';

  function style(ss, sheet, table) {
    const cols = SheetTools.columns(sheet, table);
    const n = cols.length;
    const rows = LD_CONFIG.VALIDATION_ROWS;

    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(1);
    sheet.setHiddenGridlines(true);
    sheet.getBandings().forEach((b) => b.remove());
    sheet.getRange(1, 1, rows + 1, n).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false)
      .setHeaderRowColor(LD_CONFIG.HEADER_BG).setFirstRowColor('#FFFFFF').setSecondRowColor(BAND_ALT);
    sheet.getRange(1, 1, 1, n)
      .setBackground(LD_CONFIG.HEADER_BG).setFontColor(LD_CONFIG.HEADER_FG)
      .setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle').setWrap(true)
      .setNotes([cols.map((c) => c.note || '')]);
    sheet.setRowHeight(1, 34);
    sheet.setRowHeights(2, rows, 26);
    sheet.getRange(2, 1, rows, n).setFontSize(10).setFontColor(BODY_FG).setVerticalAlignment('middle').setFontWeight('normal');
    sheet.getRange(2, 1, rows, 1).setFontWeight('bold');
    sheet.setTabColor(TAB_COLORS[table.group] || null);

    const rules = [];
    cols.forEach((c, i) => {
      const body = sheet.getRange(2, i + 1, rows, 1);
      body.setDataValidation(ruleFor(ss, c));
      if (c.type === 'bool' || c.type === 'number') body.setHorizontalAlignment('center');
      if (c.type === 'number') body.setNumberFormat('0.#');
      if (c.type === 'enum') {
        (c.values || []).forEach((v) => {
          if (!BADGE[v]) return;
          rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(v)
            .setBackground(BADGE[v][0]).setFontColor(BADGE[v][1]).setBold(true).setRanges([body]).build());
        });
      }
    });
    sheet.setConditionalFormatRules(rules);

    if (sheet.getFilter()) sheet.getFilter().remove();
    sheet.getRange(1, 1, rows + 1, n).createFilter();

    sheet.autoResizeColumns(1, n);
    for (let i = 1; i <= n; i++) {
      const w = sheet.getColumnWidth(i) + 16;
      sheet.setColumnWidth(i, Math.max(96, Math.min(360, w)));
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

  /** Overview tab: live formulas over the other tabs. Nothing to edit, safe to rebuild. */
  function writeOverview(ss) {
    const sheet = ss.getSheetByName('Overview') || ss.insertSheet('Overview');
    sheet.clear();
    sheet.clearConditionalFormatRules();
    sheet.setHiddenGridlines(true);
    sheet.getBandings().forEach((b) => b.remove());
    const col = (tab, name) => {
      const idx = SheetTools.readHeaders(ss.getSheetByName(tab)).indexOf(name);
      const letter = String.fromCharCode(65 + idx);
      return tab + '!' + letter + '2:' + letter;
    };
    const R = {
      empStatus: col('Employees', 'status'),
      status: col('LeaveRequests', 'status'), start: col('LeaveRequests', 'start_date'), end: col('LeaveRequests', 'end_date'),
      days: col('LeaveRequests', 'days'), type: col('LeaveRequests', 'type_id'),
    };
    const yearStart = 'DATE(YEAR(TODAY()),1,1)';
    const tiles = [
      ['Active people', '=COUNTIF(' + R.empStatus + ',"Active")'],
      ['Waiting for approval', '=COUNTIF(' + R.status + ',"PENDING")'],
      ['On leave today', '=COUNTIFS(' + R.status + ',"APPROVED",' + R.start + ',"<="&TODAY(),' + R.end + ',">="&TODAY())'],
      ['Approved this year', '=COUNTIFS(' + R.status + ',"APPROVED",' + R.start + ',">="&' + yearStart + ')'],
      ['Days taken this year', '=SUMIFS(' + R.days + ',' + R.status + ',"APPROVED",' + R.start + ',">="&' + yearStart + ')'],
    ];
    const req = (cols, where, order) => '=IFERROR(QUERY(LeaveRequests!A2:Q,"select ' + cols + ' where ' + where + (order ? ' order by ' + order : '') + '",0),"Nothing here")';
    const d = (expr) => 'date \'"&TEXT(' + expr + ',"yyyy-mm-dd")&"\'';
    const rq = (name) => String.fromCharCode(65 + SheetTools.readHeaders(ss.getSheetByName('LeaveRequests')).indexOf(name));
    const pick = ['req_id', 'emp_id', 'type_id', 'start_date', 'end_date', 'days', 'status'].map(rq).join(', ');

    sheet.getRange(1, 1).setValue(LD_CONFIG.APP_NAME + ' — Overview').setFontSize(18).setFontWeight('bold').setFontColor(LD_CONFIG.HEADER_BG);
    sheet.getRange(2, 1).setValue('Live numbers from the tabs on the right. Nothing to edit here; the app writes the data.').setFontColor('#56675F');
    tiles.forEach((t, i) => {
      const c = 1 + i * 2;
      sheet.getRange(4, c, 1, 2).merge().setValue(t[0]).setBackground(LD_CONFIG.HEADER_BG).setFontColor(LD_CONFIG.HEADER_FG).setFontWeight('bold').setHorizontalAlignment('center');
      sheet.getRange(5, c, 1, 2).merge().setFormula(t[1]).setFontSize(22).setFontWeight('bold').setFontColor(BODY_FG).setBackground(BAND_ALT).setHorizontalAlignment('center');
    });
    sheet.setRowHeight(5, 48);

    const block = (row, title, formula) => {
      sheet.getRange(row, 1).setValue(title).setFontWeight('bold').setFontSize(12).setFontColor(LD_CONFIG.HEADER_BG);
      sheet.getRange(row + 1, 1, 1, 7).setValues([['Request', 'Person', 'Type', 'From', 'To', 'Days', 'Status']])
        .setBackground(LD_CONFIG.HEADER_BG).setFontColor(LD_CONFIG.HEADER_FG).setFontWeight('bold');
      sheet.getRange(row + 2, 1).setFormula(formula);
      sheet.getRange(row + 2, 4, 20, 2).setNumberFormat('ddd d mmm');
    };
    block(8, 'Waiting for approval', req(pick, "' + rq('status') + '='PENDING'", rq('start')));
    block(31, 'On leave in the next 30 days', req(pick, rq('status') + "='APPROVED' and " + rq('start') + ' >= ' + d('TODAY()') + ' and ' + rq('start') + ' <= ' + d('TODAY()+30'), rq('start')));
    block(54, 'Days taken this year by leave type', '=IFERROR(QUERY(LeaveRequests!A2:Q,"select ' + rq('type') + ', sum(' + rq('days') +
      ') where ' + rq('status') + "='APPROVED' and " + rq('start') + ' >= ' + d(yearStart) + ' group by ' + rq('type') + ' label sum(' + rq('days') + ') \'\'",0),"Nothing here")');
    sheet.getRange(55, 1, 1, 7).setValues([['Leave type', 'Days', '', '', '', '', '']]);

    const rules = Object.keys(BADGE).filter((k) => ENUMS.REQ_STATUS.indexOf(k) !== -1).map((v) =>
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(v).setBackground(BADGE[v][0]).setFontColor(BADGE[v][1]).setBold(true)
        .setRanges([sheet.getRange(10, 7, 70, 1)]).build());
    sheet.setConditionalFormatRules(rules);
    sheet.setColumnWidth(1, 150); sheet.setColumnWidth(2, 110); sheet.setColumnWidth(3, 90);
    sheet.setColumnWidth(4, 110); sheet.setColumnWidth(5, 110); sheet.setColumnWidth(6, 70); sheet.setColumnWidth(7, 120);
    sheet.setTabColor(TAB_COLORS.readme);
  }

  function orderTabs(ss) {
    ['README', 'Overview'].concat(DB_SCHEMA.map((t) => t.name)).forEach((name, i) => {
      const sheet = ss.getSheetByName(name);
      if (!sheet) return;
      ss.setActiveSheet(sheet);
      ss.moveActiveSheet(i + 1);
    });
  }

  /** Deletes empty leftovers like "Sheet1". Never deletes a tab with content. */
  function removeEmptyTabs(ss) {
    const keep = ['README', 'Overview'].concat(DB_SCHEMA.map((t) => t.name));
    ss.getSheets().forEach((sheet) => {
      const empty = sheet.getLastRow() === 0 && sheet.getLastColumn() === 0;
      if (keep.indexOf(sheet.getName()) === -1 && empty && ss.getSheets().length > 1) ss.deleteSheet(sheet);
    });
  }

  return { applyNumberFormats, style, writeReadme, writeOverview, orderTabs, removeEmptyTabs };
})();
