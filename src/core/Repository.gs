/**
 * Repository.gs — generic table access for one sheet tab.
 *
 * - Columns are matched by header NAME, so column order in the sheet doesn't matter.
 * - The first column of each table (in Schema.gs) is its primary key.
 * - Rows are read once per execution and cached; writes update the cache.
 * - Returned objects are copies, so callers can't change the cache by accident.
 *
 * Get one with Db.table('Employees'); don't construct it directly.
 */
function Repository(name) {
  const def = tableDef_(name);
  const idKey = def.columns[0].name;
  const typeOf = {};
  def.columns.forEach((c) => { typeOf[c.name] = c.type; });

  let headers = null;
  let rows = null;          // array of plain objects
  let rowNumberById = null; // id -> sheet row number
  let lastDataRow = 1;      // last row holding an id (checkbox columns fill the rest with FALSE)

  function sheet() {
    const sh = Db.book().getSheetByName(name);
    if (!sh) throw Errors.setup('The "' + name + '" tab is missing. Run setupDatabase.');
    return sh;
  }

  const copy = (o) => (o ? Object.assign({}, o) : null);

  function decode(cells) {
    const obj = {};
    headers.forEach((h, j) => { if (h) obj[h] = Codec.fromCell(cells[j], typeOf[h] || 'text'); });
    return obj;
  }

  function encode(obj) {
    return headers.map((h) => Codec.toCell(obj[h], typeOf[h] || 'text'));
  }

  function load() {
    if (rows) return;
    const values = sheet().getDataRange().getValues();
    headers = (values[0] || []).map((h) => String(h).trim());
    rows = [];
    rowNumberById = {};
    lastDataRow = 1;
    const idCol = headers.indexOf(idKey);
    for (let i = 1; i < values.length; i++) {
      if (idCol === -1 || values[i][idCol] === '' || values[i][idCol] === null) continue;
      const obj = decode(values[i]);
      rows.push(obj);
      rowNumberById[obj[idKey]] = i + 1;
      lastDataRow = i + 1;
    }
  }

  function writeRow(rowNumber, obj) {
    const sh = sheet();
    if (sh.getMaxRows() < rowNumber) sh.insertRowsAfter(sh.getMaxRows(), rowNumber - sh.getMaxRows());
    sh.getRange(rowNumber, 1, 1, headers.length).setValues([encode(obj)]);
  }

  // ---- reads ----
  function all() { load(); return rows.map(copy); }
  function where(predicate) { load(); return rows.filter(predicate).map(copy); }
  function find(predicate) { load(); return copy(rows.find(predicate)); }
  function get(id) { load(); return copy(rows.find((r) => r[idKey] === id)); }

  // ---- writes ----
  function insert(obj) {
    load();
    if (!obj[idKey]) throw new Error(name + ': insert needs ' + idKey);
    if (rowNumberById[obj[idKey]]) throw new Error(name + ': duplicate id ' + obj[idKey]);
    const stored = {};
    headers.forEach((h) => { if (h) stored[h] = obj[h] === undefined ? (typeOf[h] === 'bool' ? false : '') : obj[h]; });
    const rowNumber = lastDataRow + 1;
    writeRow(rowNumber, stored);
    rows.push(stored);
    rowNumberById[stored[idKey]] = rowNumber;
    lastDataRow = rowNumber;
    return copy(stored);
  }

  function update(id, patch) {
    load();
    const index = rows.findIndex((r) => r[idKey] === id);
    if (index === -1) throw Errors.notFound(name + ' ' + id);
    const merged = Object.assign({}, rows[index], patch, { [idKey]: id });
    writeRow(rowNumberById[id], merged);
    rows[index] = merged;
    return copy(merged);
  }

  /** Next id like prefix + zero-padded number, e.g. nextId('A', 4) → 'A0025'. */
  function nextId(prefix, width) {
    load();
    let max = 0;
    rows.forEach((r) => {
      const id = String(r[idKey]);
      if (id.indexOf(prefix) !== 0) return;
      const n = parseInt(id.slice(prefix.length), 10);
      if (n > max) max = n;
    });
    return prefix + String(max + 1).padStart(width, '0');
  }

  function invalidate() { rows = null; headers = null; rowNumberById = null; }

  return { name, idKey, all, where, find, get, insert, update, nextId, invalidate };
}
