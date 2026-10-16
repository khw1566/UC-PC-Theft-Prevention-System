"""보고서의 네트워크 정보로 PC가 속한 망(호실)을 정합니다."""

import ipaddress


def primary_subnet(report: dict, remote_ip: str | None = None) -> str | None:
    """기본 게이트웨이가 있는 어댑터의 서브넷(예: 10.1.3.0/24)을 돌려줍니다.

    네트워크 정보가 없는 구버전 클라이언트는 접속 IP의 /24로 대신합니다.
    """
    entries = report.get("network") or []
    for entry in sorted(entries, key=lambda e: not e.get("gateway")):
        try:
            return str(ipaddress.ip_network(f"{entry['ip']}/{entry.get('mask') or '255.255.255.0'}", strict=False))
        except (KeyError, ValueError):
            continue
    if remote_ip:
        try:
            ip = ipaddress.ip_address(remote_ip)
        except ValueError:
            return None
        if ip.version == 4:
            return str(ipaddress.ip_network(f"{ip}/24", strict=False))
    return None
