/**
 * Config.gs — typed read access to the Settings tab (key → value).
 * Rows come from the Settings repository, which already caches per execution.
 */
const Config = (() => {
  function values() {
    const map = {};
    Db.table('Settings').all().forEach((row) => { map[row.key] = row.value; });
    return map;
  }

  function get(key, fallback) {
    const v = values()[key];
    return v === undefined || v === '' ? (fallback === undefined ? '' : fallback) : String(v);
  }
  const bool = (key) => get(key, 'FALSE').toUpperCase() === 'TRUE';
  const num = (key, fallback) => { const n = Number(get(key, fallback)); return isNaN(n) ? fallback : n; };
  const list = (key) => get(key).split(',').map((s) => s.trim()).filter(String);

  return { get, bool, num, list };
})();
