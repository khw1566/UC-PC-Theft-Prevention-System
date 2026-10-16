import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    api_key: str  # 클라이언트가 보고할 때 쓰는 키
    admin_key: str  # 대시보드 로그인/관리 API용 키
    db_path: str
    webhook_url: str | None = None  # Discord/Slack 호환 웹훅 (없으면 생략)
    overdue_days: int = 8  # 이 기간 동안 보고가 없으면 '연락 두절'
    vapid_private_pem: str | None = None  # 웹 푸시 서명 키 (없으면 자동 생성해 DB에 저장)
    vapid_subject: str = "mailto:admin@audreaming.com"


def load_settings() -> Settings:
    return Settings(
        api_key=os.environ.get("PCGUARD_API_KEY", ""),
        admin_key=os.environ.get("PCGUARD_ADMIN_KEY", ""),
        db_path=os.environ.get("PCGUARD_DB", "pcguard.db"),
        webhook_url=os.environ.get("PCGUARD_WEBHOOK_URL") or None,
        overdue_days=int(os.environ.get("PCGUARD_OVERDUE_DAYS", "8")),
        vapid_private_pem=os.environ.get("PCGUARD_VAPID_PRIVATE_PEM") or None,
        vapid_subject=os.environ.get("PCGUARD_VAPID_SUBJECT", "mailto:admin@audreaming.com"),
    )
