CREATE TABLE IF NOT EXISTS machines (
    machine_id       TEXT PRIMARY KEY,
    hostname         TEXT,
    baseline_json    TEXT NOT NULL,
    last_report_json TEXT NOT NULL,
    first_seen       TEXT NOT NULL,
    last_seen        TEXT NOT NULL,
    last_alert_sig   TEXT,
    overdue_alerted  INTEGER NOT NULL DEFAULT 0,
    subnet           TEXT,
    remote_ip        TEXT,
    offsite_alerted  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    severity     TEXT NOT NULL,
    message      TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alerts_open ON alerts (acknowledged, machine_id);
CREATE TABLE IF NOT EXISTS rooms (
    subnet TEXT PRIMARY KEY,
    name   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    data_json  TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
