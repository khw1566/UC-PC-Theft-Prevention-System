// 보고서의 네트워크 정보로 PC가 속한 망(호실)을 정하고, 학교 밖 접속을 판단합니다.
// (server/app/net.py와 같은 규칙)

function parseV4(s) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  const parts = s.split(".");
  if (parts.some((p) => Number(p) > 255 || (p.length > 1 && p[0] === "0"))) return null;
  return { version: 4, bits: 32, value: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n) };
}

function parseV6(s) {
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const last = halves.length === 2 ? tail : head;
  if (last.length && last[last.length - 1].includes(".")) {
    const v4 = parseV4(last.pop());
    if (!v4) return null;
    last.push((v4.value >> 16n).toString(16), (v4.value & 0xffffn).toString(16));
  }
  const total = head.length + tail.length;
  if (halves.length === 2 ? total > 7 : total !== 8) return null;
  const groups = [...head, ...Array(8 - total).fill("0"), ...tail];
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return { version: 6, bits: 128, value };
}

export function parseIp(text) {
  if (typeof text !== "string") return null;
  const s = text.trim();
  return s.includes(":") ? parseV6(s) : parseV4(s);
}

function prefixFromMask(mask, ip) {
  if (/^\d{1,3}$/.test(mask)) {
    const n = Number(mask);
    return n <= ip.bits ? n : null;
  }
  const m = ip.version === 4 ? parseV4(mask) : null;
  if (!m) return null;
  const bin = m.value.toString(2).padStart(32, "0");
  if (!/^1*0*$/.test(bin)) return null;
  const firstZero = bin.indexOf("0");
  return firstZero === -1 ? 32 : firstZero;
}

// "주소/접두어" 또는 "주소/마스크"를 대역으로 바꿉니다 (호스트 비트는 지움).
export function parseNetwork(text) {
  const [addr, mask] = String(text).trim().split("/");
  const ip = parseIp(addr);
  if (!ip) return null;
  const prefix = mask === undefined ? ip.bits : prefixFromMask(mask, ip);
  if (prefix === null) return null;
  const hostBits = BigInt(ip.bits - prefix);
  return { version: ip.version, prefix, base: (ip.value >> hostBits) << hostBits };
}

function v4ToString(value) {
  return [24n, 16n, 8n, 0n].map((s) => String((value >> s) & 0xffn)).join(".");
}

function contains(net, ip) {
  if (net.version !== ip.version) return false;
  const hostBits = BigInt(ip.bits - net.prefix);
  return (ip.value >> hostBits) << hostBits === net.base;
}

/**
 * 기본 게이트웨이가 있는 어댑터의 서브넷(예: 10.1.3.0/24)을 돌려줍니다.
 * 네트워크 정보가 없는 구버전 클라이언트는 접속 IP의 /24로 대신합니다.
 */
export function primarySubnet(report, remoteIp = null) {
  const entries = [...(report.network || [])].sort((a, b) => !a.gateway - !b.gateway);
  for (const entry of entries) {
    const net = parseNetwork(`${entry.ip}/${entry.mask || "255.255.255.0"}`);
    if (net && net.version === 4) return `${v4ToString(net.base)}/${net.prefix}`;
  }
  const ip = parseIp(remoteIp);
  if (ip && ip.version === 4) return `${v4ToString((ip.value >> 8n) << 8n)}/24`;
  return null;
}

export function parseSchoolNetworks(text) {
  const nets = [];
  for (const item of String(text || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const net = parseNetwork(item);
    if (net) nets.push(net);
    else console.error(`PCGUARD_SCHOOL_NETWORKS: 잘못된 대역 무시 "${item}"`);
  }
  return nets;
}

/** 보고가 학교 공인 IP 대역 밖에서 왔는지 봅니다. 대역 설정이 없거나 IP를 모르면 판단하지 않습니다. */
export function outsideSchool(remoteIp, schoolNetworks) {
  if (!schoolNetworks.length || !remoteIp) return false;
  const ip = parseIp(remoteIp);
  if (!ip) return false;
  return !schoolNetworks.some((net) => contains(net, ip));
}
