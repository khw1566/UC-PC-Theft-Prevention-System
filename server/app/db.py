import json
import sqlite3
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS machines (
    machine_id      TEXT PRIMARY KEY,
    hostname        TEXT,
    baseline_json   TEXT NOT NULL,
    last_report_json TEXT NOT NULL,
    first_seen      TEXT NOT NULL,
    last_seen       TEXT NOT NULL,
    last_alert_sig  TEXT,
    overdue_alerted INTEGER NOT NULL DEFAULT 0,
    subnet          TEXT,
    remote_ip       TEXT,
    offsite_alerted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    severity    TEXT NOT NULL,
    message     TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rooms (
    subnet  TEXT PRIMARY KEY,
    name    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint    TEXT PRIMARY KEY,
    data_json   TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


# 예전 버전으로 만든 DB에 나중에 생긴 열을 채워 넣습니다.
MACHINE_COLUMNS = {
    "subnet": "TEXT",
    "remote_ip": "TEXT",
    "offsite_alerted": "INTEGER NOT NULL DEFAULT 0",
}


def _migrate(conn) -> None:
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(machines)")}
    with conn:
        for name, decl in MACHINE_COLUMNS.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE machines ADD COLUMN {name} {decl}")


def get_machine(conn, machine_id: str):
    return conn.execute("SELECT * FROM machines WHERE machine_id = ?", (machine_id,)).fetchone()


def insert_machine(conn, report: dict, subnet: str | None, remote_ip: str | None) -> None:
    ts, data = now(), json.dumps(report, ensure_ascii=False)
    conn.execute(
        "INSERT INTO machines (machine_id, hostname, baseline_json, last_report_json, first_seen, last_seen,"
        " subnet, remote_ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (report["machine_id"], report.get("hostname"), data, data, ts, ts, subnet, remote_ip),
    )


def update_last_report(conn, report: dict, alert_sig: str | None, subnet: str | None, remote_ip: str | None) -> None:
    conn.execute(
        "UPDATE machines SET hostname = ?, last_report_json = ?, last_seen = ?, last_alert_sig = ?,"
        " overdue_alerted = 0, subnet = ?, remote_ip = ? WHERE machine_id = ?",
        (report.get("hostname"), json.dumps(report, ensure_ascii=False), now(), alert_sig, subnet, remote_ip,
         report["machine_id"]),
    )


def set_offsite_alerted(conn, machine_id: str, value: bool) -> None:
    conn.execute("UPDATE machines SET offsite_alerted = ? WHERE machine_id = ?", (int(value), machine_id))


def accept_baseline(conn, machine_id: str) -> bool:
    cur = conn.execute(
        "UPDATE machines SET baseline_json = last_report_json, last_alert_sig = NULL WHERE machine_id = ?",
        (machine_id,),
    )
    if cur.rowcount:
        conn.execute("UPDATE alerts SET acknowledged = 1 WHERE machine_id = ?", (machine_id,))
    return cur.rowcount > 0


def add_alert(conn, machine_id: str, severity: str, message: str) -> None:
    conn.execute(
        "INSERT INTO alerts (machine_id, created_at, severity, message) VALUES (?, ?, ?, ?)",
        (machine_id, now(), severity, message),
    )


def set_room_name(conn, subnet: str, name: str) -> None:
    if name:
        conn.execute(
            "INSERT INTO rooms (subnet, name) VALUES (?, ?) ON CONFLICT(subnet) DO UPDATE SET name = excluded.name",
            (subnet, name),
        )
    else:
        conn.execute("DELETE FROM rooms WHERE subnet = ?", (subnet,))


def kv_get(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def kv_set(conn, key: str, value: str) -> None:
    conn.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", (key, value))
