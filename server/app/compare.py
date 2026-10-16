"""기준(baseline) 하드웨어 구성과 새 보고서를 비교해 도난 의심 항목을 찾습니다."""

from collections import Counter
from dataclasses import dataclass

from .net import primary_subnet

# 빠지면 도난으로 볼 부품과 그 심각도
REMOVAL_SEVERITY = {"cpu": "high", "ram": "high", "disk": "high", "gpu": "high", "nic": "medium"}
KIND_LABEL = {"cpu": "CPU", "ram": "메모리", "disk": "저장장치", "gpu": "그래픽카드", "nic": "네트워크카드"}


@dataclass(frozen=True)
class Finding:
    severity: str  # high | medium | info
    message: str


def _identity(component: dict) -> str:
    # 일련번호가 없는 부품(일부 RAM/GPU)은 모델명으로 대신 식별합니다.
    key = component.get("key") or f"model:{component.get('model')}"
    return f"{component.get('kind')}|{key}"


def _describe(component: dict) -> str:
    label = KIND_LABEL.get(component.get("kind"), component.get("kind"))
    parts = [p for p in (component.get("model"), component.get("detail")) if p]
    key = component.get("key")
    text = f"{label} {' '.join(parts)}".strip()
    return f"{text} (S/N {key})" if key else text


def compare(baseline: dict, current: dict) -> list[Finding]:
    findings: list[Finding] = []

    for field, label in (("board_serial", "메인보드 일련번호"), ("bios_serial", "BIOS 일련번호")):
        before, after = baseline.get(field), current.get(field)
        if before and before != after:
            findings.append(Finding("high", f"{label} 변경: {before} → {after or '없음'}"))

    # 다른 호실(망)로 옮겨졌다면 반출 가능성이 있으므로 알립니다.
    before_net, after_net = primary_subnet(baseline), primary_subnet(current)
    if before_net and after_net and before_net != after_net:
        findings.append(Finding("medium", f"네트워크(호실) 변경: {before_net} → {after_net}"))

    base_items = {_identity(c): c for c in baseline.get("components", [])}
    curr_items = {_identity(c): c for c in current.get("components", [])}
    base_count = Counter(_identity(c) for c in baseline.get("components", []))
    curr_count = Counter(_identity(c) for c in current.get("components", []))

    for ident, n in sorted((base_count - curr_count).items()):
        comp = base_items[ident]
        severity = REMOVAL_SEVERITY.get(comp.get("kind"), "medium")
        suffix = f" ×{n}" if n > 1 else ""
        findings.append(Finding(severity, f"사라짐: {_describe(comp)}{suffix}"))

    for ident, n in sorted((curr_count - base_count).items()):
        comp = curr_items[ident]
        suffix = f" ×{n}" if n > 1 else ""
        findings.append(Finding("info", f"새로 생김: {_describe(comp)}{suffix}"))

    return findings
