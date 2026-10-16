import json
import logging
import urllib.request

log = logging.getLogger("pcguard")


def send(webhook_url: str | None, text: str) -> None:
    """Discord(content)와 Slack(text) 웹훅 모두 받아들이는 형태로 보냅니다."""
    log.warning("ALERT %s", text)
    if not webhook_url:
        return
    body = json.dumps({"content": text[:1900], "text": text}).encode()
    req = urllib.request.Request(webhook_url, data=body, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10).close()
    except Exception:
        log.exception("webhook delivery failed")
