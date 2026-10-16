// 기준(baseline) 하드웨어 구성과 새 보고서를 비교해 도난 의심 항목을 찾습니다.
// (server/app/compare.py와 같은 규칙)
import { primarySubnet } from "./net.js";

// 빠지면 도난으로 볼 부품과 그 심각도
const REMOVAL_SEVERITY = { cpu: "high", ram: "high", disk: "high", gpu: "high", nic: "medium" };
const KIND_LABEL = { cpu: "CPU", ram: "메모리", disk: "저장장치", gpu: "그래픽카드", nic: "네트워크카드" };

// 일련번호가 없는 부품(일부 RAM/GPU)은 모델명으로 대신 식별합니다.
function identity(c) {
  return `${c.kind}|${c.key || `model:${c.model ?? "None"}`}`;
}

function describe(c) {
  const label = KIND_LABEL[c.kind] || c.kind;
  const parts = [c.model, c.detail].filter(Boolean);
  const text = `${label} ${parts.join(" ")}`.trim();
  return c.key ? `${text} (S/N ${c.key})` : text;
}

function count(components) {
  const items = new Map();
  const counts = new Map();
  for (const c of components) {
    const id = identity(c);
    if (!items.has(id)) items.set(id, c);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return { items, counts };
}

// a에만 더 많이 있는 항목을 이름순으로 (Python Counter 뺄셈과 같음)
function surplus(a, b) {
  return [...a.counts]
    .map(([id, n]) => [id, n - (b.counts.get(id) || 0)])
    .filter(([, n]) => n > 0)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
}

export function compare(baseline, current) {
  const findings = [];

  for (const [field, label] of [["board_serial", "메인보드 일련번호"], ["bios_serial", "BIOS 일련번호"]]) {
    const before = baseline[field];
    const after = current[field];
    if (before && before !== after) findings.push({ severity: "high", message: `${label} 변경: ${before} → ${after || "없음"}` });
  }

  // 다른 호실(망)로 옮겨졌다면 반출 가능성이 있으므로 알립니다.
  const beforeNet = primarySubnet(baseline);
  const afterNet = primarySubnet(current);
  if (beforeNet && afterNet && beforeNet !== afterNet) {
    findings.push({ severity: "medium", message: `네트워크(호실) 변경: ${beforeNet} → ${afterNet}` });
  }

  const base = count(baseline.components || []);
  const curr = count(current.components || []);

  for (const [id, n] of surplus(base, curr)) {
    const comp = base.items.get(id);
    const suffix = n > 1 ? ` ×${n}` : "";
    findings.push({ severity: REMOVAL_SEVERITY[comp.kind] || "medium", message: `사라짐: ${describe(comp)}${suffix}` });
  }
  for (const [id, n] of surplus(curr, base)) {
    const suffix = n > 1 ? ` ×${n}` : "";
    findings.push({ severity: "info", message: `새로 생김: ${describe(curr.items.get(id))}${suffix}` });
  }
  return findings;
}
