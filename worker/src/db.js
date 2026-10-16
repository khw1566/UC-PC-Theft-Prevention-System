// D1(SQLite) 접근 함수. 스키마는 migrations/에 있습니다.

// Python 서버와 같은 형식 (예: 2026-10-16T03:54:09+00:00)
export function now(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function getMachine(db, machineId) {
  return db.prepare("SELECT * FROM machines WHERE machine_id = ?").bind(machineId).first();
}

export function insertMachine(db, report, subnet, remoteIp) {
  const ts = now();
  const data = JSON.stringify(report);
  return db.prepare(
    "INSERT INTO machines (machine_id, hostname, baseline_json, last_report_json, first_seen, last_seen,"
    + " subnet, remote_ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(report.machine_id, report.hostname, data, data, ts, ts, subnet, remoteIp);
}

export function updateLastReport(db, report, alertSig, subnet, remoteIp, offsite) {
  return db.prepare(
    "UPDATE machines SET hostname = ?, last_report_json = ?, last_seen = ?, last_alert_sig = ?,"
    + " overdue_alerted = 0, subnet = ?, remote_ip = ?, offsite_alerted = ? WHERE machine_id = ?",
  ).bind(report.hostname, JSON.stringify(report), now(), alertSig, subnet, remoteIp, offsite ? 1 : 0, report.machine_id);
}

export function addAlert(db, machineId, severity, message) {
  return db.prepare("INSERT INTO alerts (machine_id, created_at, severity, message) VALUES (?, ?, ?, ?)")
    .bind(machineId, now(), severity, message);
}

export async function acceptBaseline(db, machineId) {
  const [res] = await db.batch([
    db.prepare("UPDATE machines SET baseline_json = last_report_json, last_alert_sig = NULL WHERE machine_id = ?").bind(machineId),
    db.prepare(
      "UPDATE alerts SET acknowledged = 1 WHERE machine_id = ? AND EXISTS (SELECT 1 FROM machines WHERE machine_id = ?)",
    ).bind(machineId, machineId),
  ]);
  return res.meta.changes > 0;
}

export function setRoomName(db, subnet, name) {
  if (name) {
    return db.prepare("INSERT INTO rooms (subnet, name) VALUES (?, ?) ON CONFLICT(subnet) DO UPDATE SET name = excluded.name")
      .bind(subnet, name).run();
  }
  return db.prepare("DELETE FROM rooms WHERE subnet = ?").bind(subnet).run();
}

export async function kvGet(db, key) {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

export function kvSet(db, key, value) {
  return db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").bind(key, value).run();
}

export async function all(db, sql, ...params) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return results;
}
