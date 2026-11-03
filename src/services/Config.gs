/**
 * Config.gs — typed read access to the Settings tab (key → value).
 * Rows come from the Settings repository, which already caches per execution.
 * If a key is empty in the sheet, a Script Property with the same name is used
 * (handy for APP_URL, which belongs with the deployment rather than the data).
 */
const Config = (() => {
  function values() {
    const map = {};
    Db.table('Settings').all().forEach((row) => { map[row.key] = row.value; });
    return map;
  }

  function get(key, fallback) {
    let v = values()[key];
    if (v === undefined || v === '') v = PropertiesService.getScriptProperties().getProperty(key) || '';
    return v === undefined || v === '' ? (fallback === undefined ? '' : fallback) : String(v);
  }
  const bool = (key) => get(key, 'FALSE').toUpperCase() === 'TRUE';
  const num = (key, fallback) => { const n = Number(get(key, fallback)); return isNaN(n) ? fallback : n; };
  const list = (key) => get(key).split(',').map((s) => s.trim()).filter(String);

  return { get, bool, num, list };
})();
