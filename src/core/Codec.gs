/**
 * Codec.gs — converts between sheet cells and plain values.
 * Dates travel as 'yyyy-MM-dd' and date-times as 'yyyy-MM-dd HH:mm' strings,
 * because google.script.run cannot send Date objects to the browser.
 */
const Codec = (() => {
  const DATE = 'yyyy-MM-dd';
  const DATETIME = 'yyyy-MM-dd HH:mm';
  const tz = () => LD_CONFIG.TIMEZONE;

  function toCell(value, type) {
    if (value === undefined || value === null || value === '') return type === 'bool' ? false : '';
    switch (type) {
      case 'date':     return value instanceof Date ? value : Utilities.parseDate(String(value), tz(), DATE);
      case 'datetime': return value instanceof Date ? value : Utilities.parseDate(String(value), tz(), DATETIME);
      case 'bool':     return value === true || String(value).toUpperCase() === 'TRUE';
      default:         return value;
    }
  }

  function fromCell(value, type) {
    if (type === 'bool') return value === true || String(value).toUpperCase() === 'TRUE';
    if (value === '' || value === null || value === undefined) return '';
    switch (type) {
      case 'date':     return value instanceof Date ? Utilities.formatDate(value, tz(), DATE) : String(value);
      case 'datetime': return value instanceof Date ? Utilities.formatDate(value, tz(), DATETIME) : String(value);
      case 'number':   return Number(value);
      default:         return value instanceof Date ? Utilities.formatDate(value, tz(), DATETIME) : String(value);
    }
  }

  return { toCell, fromCell };
})();
