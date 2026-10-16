"""이상 발생 시 관리자에게 알립니다: 웹 푸시(휴대폰/PC 브라우저)와 선택적 웹훅."""

import base64
import json
import logging
import urllib.request

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid02
from pywebpush import WebPushException, webpush

from . import db
from .config import Settings

log = logging.getLogger("pcguard")


def load_vapid(conn, settings: Settings) -> Vapid02:
    """VAPID 키는 환경변수로 줄 수 있고, 없으면 처음 실행 때 만들어 DB에 보관합니다."""
    pem = settings.vapid_private_pem or db.kv_get(conn, "vapid_private_pem")
    if pem:
        return Vapid02.from_pem(pem.encode())
    vapid = Vapid02()
    vapid.generate_keys()
    with conn:
        db.kv_set(conn, "vapid_private_pem", vapid.private_pem().decode())
    return vapid


def public_key_b64(vapid: Vapid02) -> str:
    raw = vapid.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


class Notifier:
    def __init__(self, settings: Settings, conn):
        self.settings = settings
        self.conn = conn
        self.vapid = load_vapid(conn, settings)

    def send(self, title: str, body: str, url: str = "/") -> None:
        log.warning("ALERT %s: %s", title, body)
        self._push(title, body, url)
        self._webhook(f"{title}\n{body}")

    def _push(self, title: str, body: str, url: str) -> None:
        payload = json.dumps({"title": title, "body": body, "url": url}, ensure_ascii=False)
        rows = self.conn.execute("SELECT endpoint, data_json FROM push_subscriptions").fetchall()
        for row in rows:
            try:
                webpush(
                    json.loads(row["data_json"]),
                    payload,
                    vapid_private_key=self.vapid,
                    vapid_claims={"sub": self.settings.vapid_subject},
                    ttl=86400,
                    timeout=10,
                    headers={"Urgency": "high"},
                )
            except WebPushException as e:
                status = getattr(e.response, "status_code", None)
                if status in (404, 410):  # 구독이 해지된 브라우저는 정리
                    with self.conn:
                        self.conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (row["endpoint"],))
                else:
                    log.exception("web push failed")
            except Exception:
                log.exception("web push failed")

    def _webhook(self, text: str) -> None:
        if not self.settings.webhook_url:
            return
        body = json.dumps({"content": text[:1900], "text": text}).encode()
        req = urllib.request.Request(
            self.settings.webhook_url, data=body, headers={"Content-Type": "application/json"}
        )
        try:
            urllib.request.urlopen(req, timeout=10).close()
        except Exception:
            log.exception("webhook delivery failed")
