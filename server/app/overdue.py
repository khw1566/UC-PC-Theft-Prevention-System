"""정해진 기간 동안 보고가 없는 PC를 찾아 알립니다. cron으로 하루 한 번 실행하세요.

    python -m app.overdue
"""

from datetime import datetime, timedelta, timezone

from . import db, notify
from .config import Settings, load_settings


def check_overdue(settings: Settings, conn=None) -> list[str]:
    conn = conn or db.connect(settings.db_path)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=settings.overdue_days)).isoformat(timespec="seconds")
    rows = conn.execute(
        "SELECT machine_id, hostname, last_seen FROM machines WHERE last_seen < ? AND overdue_alerted = 0",
        (cutoff,),
    ).fetchall()
    flagged = []
    with conn:
        for r in rows:
            msg = f"{settings.overdue_days}일 이상 보고 없음 (마지막 {r['last_seen']})"
            db.add_alert(conn, r["machine_id"], "medium", msg)
            conn.execute("UPDATE machines SET overdue_alerted = 1 WHERE machine_id = ?", (r["machine_id"],))
            notify.send(settings.webhook_url, f"⚠️ {r['hostname']} ({r['machine_id']}) {msg}")
            flagged.append(r["machine_id"])
    return flagged


if __name__ == "__main__":
    print(check_overdue(load_settings()))
