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
    overdue_alerted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    severity    TEXT NOT NULL,
    message     TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def get_machine(conn, machine_id: str):
    return conn.execute("SELECT * FROM machines WHERE machine_id = ?", (machine_id,)).fetchone()


def insert_machine(conn, report: dict) -> None:
    ts, data = now(), json.dumps(report, ensure_ascii=False)
    conn.execute(
        "INSERT INTO machines (machine_id, hostname, baseline_json, last_report_json, first_seen, last_seen)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (report["machine_id"], report.get("hostname"), data, data, ts, ts),
    )


def update_last_report(conn, report: dict, alert_sig: str | None) -> None:
    conn.execute(
        "UPDATE machines SET hostname = ?, last_report_json = ?, last_seen = ?, last_alert_sig = ?,"
        " overdue_alerted = 0 WHERE machine_id = ?",
        (report.get("hostname"), json.dumps(report, ensure_ascii=False), now(), alert_sig, report["machine_id"]),
    )


def accept_baseline(conn, machine_id: str) -> bool:
    cur = conn.execute(
        "UPDATE machines SET baseline_json = last_report_json, last_alert_sig = NULL WHERE machine_id = ?",
        (machine_id,),
    )
    return cur.rowcount > 0


def add_alert(conn, machine_id: str, severity: str, message: str) -> None:
    conn.execute(
        "INSERT INTO alerts (machine_id, created_at, severity, message) VALUES (?, ?, ?, ?)",
        (machine_id, now(), severity, message),
    )
