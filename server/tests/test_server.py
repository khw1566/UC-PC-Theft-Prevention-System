import sqlite3
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.notify import Notifier
from app.compare import compare
from app.config import Settings
from app.main import create_app
from app.net import outside_school, primary_subnet
from app.overdue import check_overdue

BASE = {
    "machine_id": "UUID-1",
    "hostname": "LAB-01",
    "board_serial": "BOARD123",
    "bios_serial": "BIOS123",
    "network": [{"mac": "AA", "ip": "10.1.3.21", "mask": "255.255.255.0", "gateway": "10.1.3.1"}],
    "components": [
        {"kind": "cpu", "key": "BFEBFBFF000906EA", "model": "Intel i5-9400"},
        {"kind": "ram", "key": "RAMSN1", "model": "M378A", "detail": "8 GB"},
        {"kind": "ram", "key": "RAMSN2", "model": "M378A", "detail": "8 GB"},
        {"kind": "disk", "key": "SSDSN1", "model": "Samsung 860", "detail": "256 GB"},
        {"kind": "gpu", "key": None, "model": "NVIDIA GTX 1050"},
    ],
}


def with_components(components, **extra):
    return {**BASE, **extra, "components": components}


@pytest.fixture
def sent(monkeypatch):
    messages = []
    monkeypatch.setattr(Notifier, "send", lambda self, title, body, url="/": messages.append((title, body, url)))
    return messages


@pytest.fixture
def settings(tmp_path):
    return Settings(api_key="k", admin_key="a", db_path=str(tmp_path / "t.db"))


@pytest.fixture
def client(settings):
    return TestClient(create_app(settings))


def post(client, report):
    return client.post("/api/report", json=report, headers={"X-Api-Key": "k"})


def test_unchanged_has_no_findings():
    assert compare(BASE, BASE) == []


def test_removed_ram_is_high():
    current = with_components([c for c in BASE["components"] if c.get("key") != "RAMSN2"])
    [f] = compare(BASE, current)
    assert f.severity == "high" and "RAMSN2" in f.message


def test_swapped_disk_reports_removed_and_added():
    comps = [c for c in BASE["components"] if c["kind"] != "disk"] + [{"kind": "disk", "key": "OTHER", "model": "Cheap"}]
    sev = sorted(f.severity for f in compare(BASE, with_components(comps)))
    assert sev == ["high", "info"]


def test_board_change_is_high():
    [f] = compare(BASE, {**BASE, "board_serial": "XYZ"})
    assert f.severity == "high" and "메인보드" in f.message


def test_rejects_bad_key(client):
    assert client.post("/api/report", json=BASE, headers={"X-Api-Key": "nope"}).status_code == 401


def test_flow_register_alert_dedupe_accept(client, sent):
    assert post(client, BASE).json()["status"] == "registered"
    assert post(client, BASE).json()["status"] == "ok"

    stolen = with_components([c for c in BASE["components"] if c["kind"] != "ram"])
    r = post(client, stolen).json()
    assert r["status"] == "alert" and len(r["alerts"]) == 2
    assert len(sent) == 1

    # 같은 상태로 다시 보고해도 알림은 다시 보내지 않음
    post(client, stolen)
    assert len(sent) == 1

    alerts = client.get("/api/alerts", headers={"X-Admin-Key": "a"}).json()
    assert len(alerts) == 2

    assert client.post("/api/machines/UUID-1/accept", headers={"X-Admin-Key": "a"}).status_code == 200
    assert post(client, stolen).json()["status"] == "ok"


def test_overdue(client, settings, sent):
    post(client, BASE)
    conn = client.app.state.conn
    old = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat(timespec="seconds")
    with conn:
        conn.execute("UPDATE machines SET last_seen = ?", (old,))
    notifier = client.app.state.notifier
    assert check_overdue(settings, conn, notifier) == ["UUID-1"]
    assert check_overdue(settings, conn, notifier) == []
    assert len(sent) == 1


def test_subnet_change_is_medium():
    moved = {**BASE, "network": [{"ip": "10.1.9.5", "mask": "255.255.255.0", "gateway": "10.1.9.1"}]}
    [f] = compare(BASE, moved)
    assert f.severity == "medium" and "10.1.3.0/24" in f.message


def test_primary_subnet_prefers_gateway_and_falls_back_to_remote():
    report = {"network": [
        {"ip": "192.168.56.1", "mask": "255.255.255.0"},
        {"ip": "10.1.3.21", "mask": "255.255.254.0", "gateway": "10.1.2.1"},
    ]}
    assert primary_subnet(report) == "10.1.2.0/23"
    assert primary_subnet({}, "203.0.113.7") == "203.0.113.0/24"
    assert primary_subnet({}, None) is None


def test_dashboard_groups_by_room(client, sent):
    admin = {"X-Admin-Key": "a"}
    post(client, BASE)
    post(client, {**BASE, "machine_id": "UUID-2", "hostname": "LAB-02"})
    post(client, {**BASE, "machine_id": "UUID-3", "hostname": "T-01",
                  "network": [{"ip": "10.2.0.9", "mask": "255.255.255.0", "gateway": "10.2.0.1"}]})
    client.post("/api/rooms", json={"subnet": "10.1.3.0/24", "name": "301호"}, headers=admin)
    post(client, with_components([c for c in BASE["components"] if c["kind"] != "disk"]))

    d = client.get("/api/dashboard", headers=admin).json()
    rooms = {r["subnet"]: r for r in d["rooms"]}
    assert rooms["10.1.3.0/24"]["name"] == "301호"
    statuses = {m["hostname"]: m["status"] for m in rooms["10.1.3.0/24"]["machines"]}
    assert statuses == {"LAB-01": "danger", "LAB-02": "ok"}
    assert [m["hostname"] for m in rooms["10.2.0.0/24"]["machines"]] == ["T-01"]
    assert d["alerts"][0]["room"] == "301호"
    assert sent[0][0].startswith("🚨 301호 LAB-01")

    detail = client.get("/api/machines/UUID-1", headers=admin).json()
    assert detail["room"] == "301호" and detail["findings"]
    client.post("/api/machines/UUID-1/accept", headers=admin)
    d = client.get("/api/dashboard", headers=admin).json()
    assert d["alerts"] == []


def test_push_key_and_subscribe(client):
    key = client.get("/api/push/key").json()["public_key"]
    assert len(key) == 87  # 65바이트 비압축 P-256 공개키의 base64url
    sub = {"endpoint": "https://push.example/abc", "expirationTime": None, "keys": {"p256dh": "x", "auth": "y"}}
    assert client.post("/api/push/subscribe", json=sub).status_code == 401
    assert client.post("/api/push/subscribe", json=sub, headers={"X-Admin-Key": "a"}).status_code == 200
    # 같은 DB로 다시 띄워도 VAPID 키가 유지돼야 기존 구독이 계속 동작함
    again = TestClient(create_app(client.app.state.settings)).get("/api/push/key").json()["public_key"]
    assert again == key


def test_dashboard_page_served(client):
    assert "PCGuard" in client.get("/").text
    assert client.get("/sw.js").headers["content-type"].startswith("text/javascript")
    assert client.get("/static/app.js").status_code == 200


def test_outside_school():
    nets = ("203.0.113.0/24", "198.51.100.7")
    assert not outside_school("203.0.113.50", nets)
    assert not outside_school("198.51.100.7", nets)
    assert outside_school("8.8.8.8", nets)
    # 대역 설정이 없거나 IP를 모르면 판단하지 않음
    assert not outside_school("8.8.8.8", ())
    assert not outside_school(None, nets)
    assert not outside_school("garbage", nets)


def test_offsite_alerts_once_until_back_at_school(settings, sent):
    client = TestClient(create_app(replace(settings, school_networks=("203.0.113.0/24",))))

    def post_from(ip):
        return client.post("/api/report", json=BASE, headers={"X-Api-Key": "k", "X-Forwarded-For": ip}).json()

    assert post_from("203.0.113.10")["status"] == "registered"
    assert post_from("203.0.113.10")["status"] == "ok"

    r = post_from("8.8.8.8")
    assert r["status"] == "alert" and "8.8.8.8" in r["alerts"][0]
    assert len(sent) == 1 and "학교 밖" in sent[0][1]

    # 밖에 있는 동안 쌓인 보고가 계속 와도 알림은 한 번만
    assert post_from("8.8.4.4")["status"] == "alert"
    assert len(sent) == 1

    alerts = client.get("/api/alerts", headers={"X-Admin-Key": "a"}).json()
    assert [a["severity"] for a in alerts] == ["high"]
    d = client.get("/api/dashboard", headers={"X-Admin-Key": "a"}).json()
    assert d["rooms"][0]["machines"][0]["status"] == "danger"

    # 학교로 돌아오면 다시 감시하고, 또 나가면 다시 알림
    assert post_from("203.0.113.10")["status"] == "ok"
    post_from("8.8.8.8")
    assert len(sent) == 2


def test_offsite_check_off_without_school_networks(client, sent):
    post(client, BASE)
    r = client.post("/api/report", json=BASE, headers={"X-Api-Key": "k", "X-Forwarded-For": "8.8.8.8"}).json()
    assert r["status"] == "ok" and sent == []


def test_old_db_gets_new_columns(tmp_path):
    path = str(tmp_path / "old.db")
    old = sqlite3.connect(path)
    old.execute(
        "CREATE TABLE machines (machine_id TEXT PRIMARY KEY, hostname TEXT, baseline_json TEXT NOT NULL,"
        " last_report_json TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,"
        " last_alert_sig TEXT, overdue_alerted INTEGER NOT NULL DEFAULT 0)"
    )
    old.commit()
    old.close()
    client = TestClient(create_app(Settings(api_key="k", admin_key="a", db_path=path)))
    assert post(client, BASE).json()["status"] == "registered"
    assert post(client, BASE).json()["status"] == "ok"


def test_offsite_with_missing_parts_alerts_each_once(settings, sent):
    client = TestClient(create_app(replace(settings, school_networks=("203.0.113.0/24",))))
    headers = {"X-Api-Key": "k", "X-Forwarded-For": "203.0.113.10"}
    client.post("/api/report", json=BASE, headers=headers)
    stripped = with_components([c for c in BASE["components"] if c["kind"] != "disk"])
    r = client.post("/api/report", json=stripped, headers={**headers, "X-Forwarded-For": "8.8.8.8"}).json()
    assert len(r["alerts"]) == 2
    assert len(client.get("/api/alerts", headers={"X-Admin-Key": "a"}).json()) == 2
    assert len(sent) == 1 and sent[0][1].count("\n") == 1
