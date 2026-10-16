"""정해진 기간 동안 보고가 없는 PC를 찾아 알립니다. cron으로 하루 한 번 실행하세요.

    python -m app.overdue
"""

from datetime import datetime, timedelta, timezone

from . import db
from .config import Settings, load_settings
from .notify import Notifier


def check_overdue(settings: Settings, conn=None, notifier: Notifier | None = None) -> list[str]:
    conn = conn or db.connect(settings.db_path)
    notifier = notifier or Notifier(settings, conn)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=settings.overdue_days)).isoformat(timespec="seconds")
    rows = conn.execute(
        "SELECT m.machine_id, m.hostname, m.last_seen, COALESCE(r.name, m.subnet, '미분류') AS room"
        " FROM machines m LEFT JOIN rooms r ON r.subnet = m.subnet"
        " WHERE m.last_seen < ? AND m.overdue_alerted = 0"
        " AND (m.paused_until IS NULL OR m.paused_until <= ?)",
        (cutoff, db.now()),
    ).fetchall()
    flagged = []
    with conn:
        for r in rows:
            msg = f"{settings.overdue_days}일 이상 보고 없음 (마지막 보고 {r['last_seen'][:10]})"
            db.add_alert(conn, r["machine_id"], "medium", msg)
            conn.execute("UPDATE machines SET overdue_alerted = 1 WHERE machine_id = ?", (r["machine_id"],))
            flagged.append((r, msg))
    for r, msg in flagged:
        notifier.send(f"⚠️ {r['room']} {r['hostname']} 연락 두절", msg, f"/#pc={r['machine_id']}")
    return [r["machine_id"] for r, _ in flagged]


if __name__ == "__main__":
    print(check_overdue(load_settings()))
