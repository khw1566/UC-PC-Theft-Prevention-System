from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import notify
from app.compare import compare
from app.config import Settings
from app.main import create_app
from app.overdue import check_overdue

BASE = {
    "machine_id": "UUID-1",
    "hostname": "LAB-01",
    "board_serial": "BOARD123",
    "bios_serial": "BIOS123",
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
    monkeypatch.setattr(notify, "send", lambda url, text: messages.append(text))
    return messages


@pytest.fixture
def settings(tmp_path):
    return Settings(api_key="k", admin_key="a", db_path=str(tmp_path / "t.db"), webhook_url=None, overdue_days=8)


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
    assert check_overdue(settings, conn) == ["UUID-1"]
    assert check_overdue(settings, conn) == []
    assert len(sent) == 1
