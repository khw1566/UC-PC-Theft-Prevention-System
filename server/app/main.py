import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db
from .compare import Finding, compare
from .config import Settings, load_settings
from .net import outside_school, primary_subnet
from .notify import Notifier, public_key_b64

STATIC = Path(__file__).parent / "static"


class Component(BaseModel):
    kind: str
    key: str | None = None
    model: str | None = None
    detail: str | None = None


class NetEntry(BaseModel):
    mac: str | None = None
    ip: str
    mask: str | None = None
    gateway: str | None = None


class Report(BaseModel):
    machine_id: str
    hostname: str | None = None
    collected_at: str | None = None
    board_serial: str | None = None
    bios_serial: str | None = None
    manufacturer: str | None = None
    product: str | None = None
    os: str | None = None
    components: list[Component] = []
    network: list[NetEntry] = []
    client_version: str | None = None


class RoomName(BaseModel):
    subnet: str
    name: str


class ClientMemo(BaseModel):
    machine_id: str
    memo: str = Field("", max_length=500)


class ClientTestAlert(BaseModel):
    machine_id: str
    message: str = Field("", max_length=200)


# 클라이언트 메뉴에서 끌 수 있는 기능
DISABLE_FEATURES = {"startup_report", "weekly_report"}


class DisableRequest(BaseModel):
    hours: float = Field(0, ge=0, le=24 * 30)  # 서버 알림 일시중지 시간, 0이면 해제
    reason: str = Field("", max_length=200)
    disabled: list[str] = []


TEST_ALERT_INTERVAL = timedelta(seconds=30)


class PushSubscription(BaseModel):
    endpoint: str
    keys: dict[str, str]


def client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    conn = db.connect(settings.db_path)
    notifier = Notifier(settings, conn)
    app = FastAPI(title="PCGuard")
    app.state.settings, app.state.conn, app.state.notifier = settings, conn, notifier

    def check_key(expected: str, given: str | None) -> None:
        if not expected or not given or not hmac.compare_digest(expected, given):
            raise HTTPException(status_code=401, detail="invalid key")

    def client_auth(x_api_key: str | None = Header(default=None)) -> None:
        check_key(settings.api_key, x_api_key)

    def admin_auth(x_admin_key: str | None = Header(default=None)) -> None:
        check_key(settings.admin_key, x_admin_key)

    # ---- 클라이언트 보고 ----

    @app.post("/api/report", dependencies=[Depends(client_auth)])
    def report(body: Report, request: Request):
        data = body.model_dump()
        remote_ip = client_ip(request)
        subnet = primary_subnet(data, remote_ip)
        machine = db.get_machine(conn, body.machine_id)
        with conn:
            if machine is None:
                db.insert_machine(conn, data, subnet, remote_ip)
                return {"status": "registered", "alerts": []}

            findings = compare(json.loads(machine["baseline_json"]), data)
            alerts = [f for f in findings if f.severity != "info"]
            sig = hashlib.sha256("\n".join(f.message for f in findings).encode()).hexdigest() if findings else None
            # 점검(일시중지) 중에는 알리지 않고, 서명도 그대로 둬서 끝난 뒤 첫 보고에서 알립니다.
            paused = db.is_paused(machine)
            if paused:
                sig = machine["last_alert_sig"]

            # 같은 변경이 매주 반복 보고돼도 알림은 처음 한 번만 보냅니다.
            new_alerts = list(alerts) if sig != machine["last_alert_sig"] else []

            # 학교 밖에서 켜졌다면 PC째 반출된 것일 수 있으므로 바로 알립니다.
            # 다시 학교 안에서 보고할 때까지는 한 번만 알립니다.
            offsite = outside_school(remote_ip, settings.school_networks)
            if offsite:
                finding = Finding("high", f"학교 밖 네트워크에서 켜짐 (접속 IP {remote_ip})")
                alerts.append(finding)
                if not machine["offsite_alerted"] and not paused:
                    new_alerts.append(finding)

            for f in new_alerts:
                db.add_alert(conn, body.machine_id, f.severity, f.message)
            db.update_last_report(conn, data, sig, subnet, remote_ip)
            # 일시중지 중에 밖에 있었다면 끝난 뒤 첫 보고에서 알리도록 표시하지 않습니다.
            db.set_offsite_alerted(conn, body.machine_id, offsite and (not paused or bool(machine["offsite_alerted"])))

        if new_alerts:
            room = room_label(subnet)
            notifier.send(
                f"🚨 {room} {body.hostname} 이상 감지",
                "\n".join(f.message for f in new_alerts),
                f"/#pc={body.machine_id}",
            )
        return {"status": "alert" if alerts else "ok", "alerts": [f.message for f in alerts]}

    # ---- 클라이언트 메뉴 (PC의 관리 메뉴 GUI) ----

    def require_machine(machine_id: str):
        m = db.get_machine(conn, machine_id)
        if m is None:
            raise HTTPException(status_code=404, detail="unknown machine")
        return m

    @app.get("/api/client/status", dependencies=[Depends(client_auth)])
    def client_status(machine_id: str):
        m = db.get_machine(conn, machine_id)
        if m is None:
            return {"registered": False}
        open_alerts = conn.execute(
            "SELECT COUNT(*) FROM alerts WHERE machine_id = ? AND acknowledged = 0", (machine_id,)
        ).fetchone()[0]
        return {
            "registered": True,
            "hostname": m["hostname"],
            "room": room_label(m["subnet"]),
            "last_seen": m["last_seen"],
            "open_alerts": open_alerts,
            "memo": m["memo"] or "",
            "paused_until": m["paused_until"] if db.is_paused(m) else None,
            "disabled": json.loads(m["disabled_json"]),
        }

    @app.post("/api/client/memo", dependencies=[Depends(client_auth)])
    def client_memo(body: ClientMemo):
        with conn:
            if not db.set_memo(conn, body.machine_id, body.memo.strip()):
                raise HTTPException(status_code=404, detail="unknown machine")
        return {"ok": True}

    @app.post("/api/client/test-alert", dependencies=[Depends(client_auth)])
    def client_test_alert(body: ClientTestAlert):
        m = require_machine(body.machine_id)
        since = (datetime.now(timezone.utc) - TEST_ALERT_INTERVAL).isoformat(timespec="seconds")
        recent = conn.execute(
            "SELECT 1 FROM alerts WHERE machine_id = ? AND severity = 'test' AND created_at > ?",
            (body.machine_id, since),
        ).fetchone()
        if recent:
            raise HTTPException(status_code=429, detail="test alert sent too recently")
        message = "[테스트] 도난 알림 테스트" + (f": {body.message.strip()}" if body.message.strip() else "")
        with conn:
            db.add_alert(conn, body.machine_id, "test", message)
        notifier.send(f"🧪 [테스트] {room_label(m['subnet'])} {m['hostname']} 도난 알림", message, f"/#pc={body.machine_id}")
        return {"ok": True}

    @app.post("/api/machines/{machine_id}/disable", dependencies=[Depends(admin_auth)])
    def disable(machine_id: str, body: DisableRequest):
        """점검·수리 중인 PC의 서버 알림을 잠시 멈추고, PC에서 끈 기능을 기록합니다."""
        unknown = set(body.disabled) - DISABLE_FEATURES
        if unknown:
            raise HTTPException(status_code=422, detail=f"unknown features: {sorted(unknown)}")
        until = None
        if body.hours > 0:
            until = (datetime.now(timezone.utc) + timedelta(hours=body.hours)).isoformat(timespec="seconds")
        with conn:
            if not db.set_disabled(conn, machine_id, until, body.reason.strip(), sorted(set(body.disabled))):
                raise HTTPException(status_code=404, detail="unknown machine")
        return {"ok": True, "paused_until": until}

    # ---- 대시보드 ----

    def room_label(subnet: str | None) -> str:
        if not subnet:
            return "미분류"
        row = conn.execute("SELECT name FROM rooms WHERE subnet = ?", (subnet,)).fetchone()
        return row["name"] if row else subnet

    def machine_status(row, open_alerts: list[dict], cutoff: str) -> str:
        if any(a["severity"] == "high" for a in open_alerts):
            return "danger"
        if db.is_paused(row):
            return "paused"
        if row["last_seen"] < cutoff:
            return "offline"
        if open_alerts:
            return "warning"
        return "ok"

    @app.get("/api/dashboard", dependencies=[Depends(admin_auth)])
    def dashboard():
        cutoff = (datetime.now(timezone.utc) - timedelta(days=settings.overdue_days)).isoformat(timespec="seconds")
        names = {r["subnet"]: r["name"] for r in conn.execute("SELECT * FROM rooms")}
        open_alerts: dict[str, list[dict]] = {}
        for a in conn.execute("SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY id DESC"):
            open_alerts.setdefault(a["machine_id"], []).append(dict(a))

        rooms: dict[str, dict] = {}
        for subnet, name in names.items():
            rooms[subnet] = {"subnet": subnet, "name": name, "machines": []}
        for m in conn.execute("SELECT * FROM machines ORDER BY hostname"):
            subnet = m["subnet"] or ""
            room = rooms.setdefault(subnet, {"subnet": subnet, "name": names.get(subnet), "machines": []})
            report = json.loads(m["last_report_json"])
            ip = next((n["ip"] for n in report.get("network") or [] if n.get("gateway")), m["remote_ip"])
            alerts = open_alerts.get(m["machine_id"], [])
            room["machines"].append({
                "machine_id": m["machine_id"],
                "hostname": m["hostname"],
                "ip": ip,
                "last_seen": m["last_seen"],
                "status": machine_status(m, alerts, cutoff),
                "open_alerts": len(alerts),
                "memo": m["memo"],
                "disabled": json.loads(m["disabled_json"]),
            })

        ordered = sorted(rooms.values(), key=lambda r: (r["subnet"] == "", r["name"] is None, r["name"] or "", r["subnet"]))
        machine_rooms = {m["machine_id"]: r for r in ordered for m in r["machines"]}
        alert_list = []
        for mid, items in open_alerts.items():
            room = machine_rooms.get(mid)
            host = next((m["hostname"] for m in (room or {}).get("machines", []) if m["machine_id"] == mid), mid)
            for a in items:
                alert_list.append({**a, "hostname": host, "room": (room or {}).get("name") or (room or {}).get("subnet")})
        alert_list.sort(key=lambda a: a["id"], reverse=True)

        return {"rooms": ordered, "alerts": alert_list, "overdue_days": settings.overdue_days, "now": db.now()}

    @app.get("/api/machines", dependencies=[Depends(admin_auth)])
    def machines():
        rows = conn.execute("SELECT machine_id, hostname, subnet, first_seen, last_seen FROM machines ORDER BY hostname")
        return [dict(r) for r in rows]

    @app.get("/api/machines/{machine_id}", dependencies=[Depends(admin_auth)])
    def machine_detail(machine_id: str):
        m = db.get_machine(conn, machine_id)
        if m is None:
            raise HTTPException(status_code=404, detail="unknown machine")
        alerts = conn.execute("SELECT * FROM alerts WHERE machine_id = ? ORDER BY id DESC LIMIT 50", (machine_id,))
        baseline, current = json.loads(m["baseline_json"]), json.loads(m["last_report_json"])
        return {
            "machine_id": machine_id,
            "hostname": m["hostname"],
            "room": room_label(m["subnet"]),
            "subnet": m["subnet"],
            "remote_ip": m["remote_ip"],
            "first_seen": m["first_seen"],
            "last_seen": m["last_seen"],
            "memo": m["memo"],
            "memo_updated_at": m["memo_updated_at"],
            "paused_until": m["paused_until"] if db.is_paused(m) else None,
            "pause_reason": m["pause_reason"],
            "disabled": json.loads(m["disabled_json"]),
            "report": current,
            "findings": [f.__dict__ for f in compare(baseline, current)],
            "alerts": [dict(a) for a in alerts],
        }

    @app.post("/api/machines/{machine_id}/accept", dependencies=[Depends(admin_auth)])
    def accept(machine_id: str):
        """부품을 정상적으로 교체/이동했을 때 현재 구성을 새 기준으로 삼고 열린 알림을 닫습니다."""
        with conn:
            if not db.accept_baseline(conn, machine_id):
                raise HTTPException(status_code=404, detail="unknown machine")
        return {"ok": True}

    @app.get("/api/alerts", dependencies=[Depends(admin_auth)])
    def alerts(include_acknowledged: bool = False):
        sql = "SELECT * FROM alerts" + ("" if include_acknowledged else " WHERE acknowledged = 0")
        return [dict(r) for r in conn.execute(sql + " ORDER BY id DESC")]

    @app.post("/api/alerts/{alert_id}/ack", dependencies=[Depends(admin_auth)])
    def ack(alert_id: int):
        with conn:
            conn.execute("UPDATE alerts SET acknowledged = 1 WHERE id = ?", (alert_id,))
        return {"ok": True}

    @app.post("/api/rooms", dependencies=[Depends(admin_auth)])
    def name_room(body: RoomName):
        with conn:
            db.set_room_name(conn, body.subnet, body.name.strip())
        return {"ok": True}

    # ---- 웹 푸시 ----

    @app.get("/api/push/key")
    def push_key():
        return {"public_key": public_key_b64(notifier.vapid)}

    @app.post("/api/push/subscribe", dependencies=[Depends(admin_auth)])
    def subscribe(sub: PushSubscription):
        with conn:
            conn.execute(
                "INSERT OR REPLACE INTO push_subscriptions (endpoint, data_json, created_at) VALUES (?, ?, ?)",
                (sub.endpoint, sub.model_dump_json(), db.now()),
            )
        return {"ok": True}

    @app.post("/api/push/test", dependencies=[Depends(admin_auth)])
    def push_test():
        notifier.send("✅ PCGuard 알림 테스트", "이 기기에서 알림을 받을 수 있어요.")
        return {"ok": True}

    # ---- 정적 파일 (PWA) ----

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/sw.js", include_in_schema=False)
    def service_worker():
        # 서비스 워커는 사이트 전체(/)를 다루도록 루트에서 제공해야 합니다.
        return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})

    @app.get("/manifest.webmanifest", include_in_schema=False)
    def manifest():
        return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app
