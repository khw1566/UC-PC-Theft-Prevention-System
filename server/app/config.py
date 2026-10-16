import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    api_key: str  # 클라이언트가 보고할 때 쓰는 키
    admin_key: str  # 관리자 조회/기준 갱신용 키
    db_path: str
    webhook_url: str | None  # Discord/Slack 호환 웹훅 (없으면 알림 생략)
    overdue_days: int  # 이 기간 동안 보고가 없으면 '연락 두절' 알림


def load_settings() -> Settings:
    return Settings(
        api_key=os.environ.get("PCGUARD_API_KEY", ""),
        admin_key=os.environ.get("PCGUARD_ADMIN_KEY", ""),
        db_path=os.environ.get("PCGUARD_DB", "pcguard.db"),
        webhook_url=os.environ.get("PCGUARD_WEBHOOK_URL") or None,
        overdue_days=int(os.environ.get("PCGUARD_OVERDUE_DAYS", "8")),
    )
