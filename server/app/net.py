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


def outside_school(remote_ip: str | None, school_networks: tuple[str, ...]) -> bool:
    """보고가 학교 공인 IP 대역 밖에서 왔는지 봅니다. 대역 설정이 없거나 IP를 모르면 판단하지 않습니다."""
    if not school_networks or not remote_ip:
        return False
    try:
        ip = ipaddress.ip_address(remote_ip)
    except ValueError:
        return False
    return not any(ip in ipaddress.ip_network(n, strict=False) for n in school_networks)
