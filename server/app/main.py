import hashlib
import hmac
import json

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

from . import db, notify
from .compare import compare
from .config import Settings, load_settings


class Component(BaseModel):
    kind: str
    key: str | None = None
    model: str | None = None
    detail: str | None = None


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
    client_version: str | None = None


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    conn = db.connect(settings.db_path)
    app = FastAPI(title="PCGuard")
    app.state.settings, app.state.conn = settings, conn

    def check_key(expected: str, given: str | None) -> None:
        if not expected or not given or not hmac.compare_digest(expected, given):
            raise HTTPException(status_code=401, detail="invalid key")

    def client_auth(x_api_key: str | None = Header(default=None)) -> None:
        check_key(settings.api_key, x_api_key)

    def admin_auth(x_admin_key: str | None = Header(default=None)) -> None:
        check_key(settings.admin_key, x_admin_key)

    @app.post("/api/report", dependencies=[Depends(client_auth)])
    def report(body: Report):
        data = body.model_dump()
        machine = db.get_machine(conn, body.machine_id)
        with conn:
            if machine is None:
                db.insert_machine(conn, data)
                return {"status": "registered", "alerts": []}

            findings = compare(json.loads(machine["baseline_json"]), data)
            alerts = [f for f in findings if f.severity != "info"]
            sig = hashlib.sha256("\n".join(f.message for f in findings).encode()).hexdigest() if findings else None

            # 같은 변경이 매주 반복 보고돼도 알림은 처음 한 번만 보냅니다.
            if alerts and sig != machine["last_alert_sig"]:
                for f in alerts:
                    db.add_alert(conn, body.machine_id, f.severity, f.message)
                lines = "\n".join(f"- [{f.severity}] {f.message}" for f in alerts)
                notify.send(settings.webhook_url, f"🚨 {body.hostname} ({body.machine_id}) 하드웨어 변경 감지\n{lines}")
            db.update_last_report(conn, data, sig)

        return {"status": "alert" if alerts else "ok", "alerts": [f.message for f in alerts]}

    @app.get("/api/machines", dependencies=[Depends(admin_auth)])
    def machines():
        rows = conn.execute("SELECT machine_id, hostname, first_seen, last_seen FROM machines ORDER BY hostname")
        return [dict(r) for r in rows]

    @app.get("/api/alerts", dependencies=[Depends(admin_auth)])
    def alerts(include_acknowledged: bool = False):
        sql = "SELECT * FROM alerts" + ("" if include_acknowledged else " WHERE acknowledged = 0")
        return [dict(r) for r in conn.execute(sql + " ORDER BY id DESC")]

    @app.post("/api/alerts/{alert_id}/ack", dependencies=[Depends(admin_auth)])
    def ack(alert_id: int):
        with conn:
            conn.execute("UPDATE alerts SET acknowledged = 1 WHERE id = ?", (alert_id,))
        return {"ok": True}

    @app.post("/api/machines/{machine_id}/accept", dependencies=[Depends(admin_auth)])
    def accept(machine_id: str):
        """부품을 정상적으로 교체/업그레이드했을 때 현재 구성을 새 기준으로 삼습니다."""
        with conn:
            if not db.accept_baseline(conn, machine_id):
                raise HTTPException(status_code=404, detail="unknown machine")
        return {"ok": True}

    return app
