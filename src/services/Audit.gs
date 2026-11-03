/**
 * Audit.gs — append-only change log (AuditLog tab).
 */
const Audit = (() => {
  const text = (v) => (v === undefined || v === null ? '' : String(v));

  /** @param {{actor?, action, entity, entity_id, field?, old_value?, new_value?, reason?}} entry */
  function log(entry) {
    const table = Db.table('AuditLog');
    table.insert({
      log_id: table.nextId('L', 6),
      timestamp: DateUtil.now(),
      actor: entry.actor || 'system',
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entity_id,
      field: text(entry.field),
      old_value: text(entry.old_value),
      new_value: text(entry.new_value),
      reason: text(entry.reason),
    });
  }

  return { log };
})();
