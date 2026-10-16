// PCGuard 감시 서버 (Cloudflare Workers + D1). server/app/main.py와 같은 API를 제공합니다.
import { compare } from "./compare.js";
import * as db from "./db.js";
import { outsideSchool, parseSchoolNetworks, primarySubnet } from "./net.js";
import { loadVapid, notify } from "./notify.js";
import { vapidPublicKey } from "./webpush.js";

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function sha256Hex(text) {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 해시끼리 비교해 길이나 내용에 따라 걸리는 시간이 달라지지 않게 합니다.
async function checkKey(expected, given) {
  if (!expected || !given) throw new HttpError(401, "invalid key");
  const [a, b] = await Promise.all([sha256(expected), sha256(given)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) throw new HttpError(401, "invalid key");
}

function settings(env) {
  return {
    overdueDays: Number(env.PCGUARD_OVERDUE_DAYS || 8),
    schoolNetworks: parseSchoolNetworks(env.PCGUARD_SCHOOL_NETWORKS),
  };
}

function cutoff(days) {
  return db.now(new Date(Date.now() - days * 86400 * 1000));
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(422, "invalid JSON");
  }
}

// ---- 보고서 검증 (main.py의 Report 모델과 같은 모양으로 정리해 저장) ----

function optStr(obj, field) {
  const v = obj[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HttpError(422, `${field} must be a string`);
  return v;
}

function reqStr(obj, field) {
  const v = optStr(obj, field);
  if (v === null) throw new HttpError(422, `${field} is required`);
  return v;
}

function list(value) {
  if (value === undefined || value === null) return [];
  // PowerShell 5.1의 ConvertTo-Json은 원소가 하나뿐인 배열을 객체로 내보내기도 합니다.
  return Array.isArray(value) ? value : [value];
}

function object(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(422, "expected an object");
  return v;
}

function parseReport(body) {
  body = object(body);
  const machineId = reqStr(body, "machine_id");
  if (!machineId) throw new HttpError(422, "machine_id is required");
  return {
    machine_id: machineId,
    hostname: optStr(body, "hostname"),
    collected_at: optStr(body, "collected_at"),
    board_serial: optStr(body, "board_serial"),
    bios_serial: optStr(body, "bios_serial"),
    manufacturer: optStr(body, "manufacturer"),
    product: optStr(body, "product"),
    os: optStr(body, "os"),
    components: list(body.components).map((c) => (c = object(c), {
      kind: reqStr(c, "kind"), key: optStr(c, "key"), model: optStr(c, "model"), detail: optStr(c, "detail"),
    })),
    network: list(body.network).map((n) => (n = object(n), {
      mac: optStr(n, "mac"), ip: reqStr(n, "ip"), mask: optStr(n, "mask"), gateway: optStr(n, "gateway"),
    })),
    client_version: optStr(body, "client_version"),
  };
}

// ---- 핸들러 ----

async function roomLabel(env, subnet) {
  if (!subnet) return "미분류";
  const row = await env.DB.prepare("SELECT name FROM rooms WHERE subnet = ?").bind(subnet).first();
  return row ? row.name : subnet;
}

async function report(request, env, ctx) {
  await checkKey(env.PCGUARD_API_KEY, request.headers.get("X-Api-Key"));
  const data = parseReport(await readJson(request));
  // Cloudflare가 넣어 주는 실제 접속 IP라 클라이언트가 속일 수 없습니다.
  const remoteIp = request.headers.get("CF-Connecting-IP");
  const subnet = primarySubnet(data, remoteIp);
  const machine = await db.getMachine(env.DB, data.machine_id);

  if (!machine) {
    await db.insertMachine(env.DB, data, subnet, remoteIp).run();
    return json({ status: "registered", alerts: [] });
  }

  const findings = compare(JSON.parse(machine.baseline_json), data);
  const alerts = findings.filter((f) => f.severity !== "info");
  const sig = findings.length ? await sha256Hex(findings.map((f) => f.message).join("\n")) : null;

  // 같은 변경이 매주 반복 보고돼도 알림은 처음 한 번만 보냅니다.
  const newAlerts = sig !== machine.last_alert_sig ? [...alerts] : [];

  // 학교 밖에서 켜졌다면 PC째 반출된 것일 수 있으므로 바로 알립니다.
  // 다시 학교 안에서 보고할 때까지는 한 번만 알립니다.
  const offsite = outsideSchool(remoteIp, settings(env).schoolNetworks);
  if (offsite) {
    const finding = { severity: "high", message: `학교 밖 네트워크에서 켜짐 (접속 IP ${remoteIp})` };
    alerts.push(finding);
    if (!machine.offsite_alerted) newAlerts.push(finding);
  }

  await env.DB.batch([
    ...newAlerts.map((f) => db.addAlert(env.DB, data.machine_id, f.severity, f.message)),
    db.updateLastReport(env.DB, data, sig, subnet, remoteIp, offsite),
  ]);

  if (newAlerts.length) {
    const room = await roomLabel(env, subnet);
    ctx.waitUntil(notify(
      env,
      `🚨 ${room} ${data.hostname || data.machine_id} 이상 감지`,
      newAlerts.map((f) => f.message).join("\n"),
      `/#pc=${data.machine_id}`,
    ));
  }
  return json({ status: alerts.length ? "alert" : "ok", alerts: alerts.map((f) => f.message) });
}

function machineStatus(row, openAlerts, since) {
  if (openAlerts.some((a) => a.severity === "high")) return "danger";
  if (row.last_seen < since) return "offline";
  if (openAlerts.length) return "warning";
  return "ok";
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function dashboard(env) {
  const { overdueDays } = settings(env);
  const since = cutoff(overdueDays);
  const [roomRows, alertRows, machineRows] = await Promise.all([
    db.all(env.DB, "SELECT * FROM rooms"),
    db.all(env.DB, "SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY id DESC"),
    db.all(env.DB, "SELECT * FROM machines ORDER BY hostname"),
  ]);
  const names = new Map(roomRows.map((r) => [r.subnet, r.name]));
  const openAlerts = new Map();
  for (const a of alertRows) {
    if (!openAlerts.has(a.machine_id)) openAlerts.set(a.machine_id, []);
    openAlerts.get(a.machine_id).push(a);
  }

  const rooms = new Map();
  for (const [subnet, name] of names) rooms.set(subnet, { subnet, name, machines: [] });
  for (const m of machineRows) {
    const subnet = m.subnet || "";
    if (!rooms.has(subnet)) rooms.set(subnet, { subnet, name: names.get(subnet) ?? null, machines: [] });
    const reportData = JSON.parse(m.last_report_json);
    const ip = (reportData.network || []).find((n) => n.gateway)?.ip ?? m.remote_ip;
    const alerts = openAlerts.get(m.machine_id) || [];
    rooms.get(subnet).machines.push({
      machine_id: m.machine_id,
      hostname: m.hostname,
      ip,
      last_seen: m.last_seen,
      status: machineStatus(m, alerts, since),
      open_alerts: alerts.length,
    });
  }

  // 이름 붙은 호실 → 이름 없는 호실 → 미분류 순
  const ordered = [...rooms.values()].sort((a, b) =>
    cmp(a.subnet === "", b.subnet === "") || cmp(a.name === null, b.name === null)
    || cmp(a.name || "", b.name || "") || cmp(a.subnet, b.subnet));

  const machineRooms = new Map();
  for (const r of ordered) for (const m of r.machines) machineRooms.set(m.machine_id, { room: r, machine: m });
  const alertList = [];
  for (const [mid, items] of openAlerts) {
    const found = machineRooms.get(mid);
    for (const a of items) {
      alertList.push({
        ...a,
        hostname: found ? found.machine.hostname : mid,
        room: found ? found.room.name || found.room.subnet : null,
      });
    }
  }
  alertList.sort((a, b) => b.id - a.id);

  return json({ rooms: ordered, alerts: alertList, overdue_days: overdueDays, now: db.now() });
}

async function machineDetail(env, machineId) {
  const m = await db.getMachine(env.DB, machineId);
  if (!m) throw new HttpError(404, "unknown machine");
  const alerts = await db.all(env.DB, "SELECT * FROM alerts WHERE machine_id = ? ORDER BY id DESC LIMIT 50", machineId);
  const current = JSON.parse(m.last_report_json);
  return json({
    machine_id: machineId,
    hostname: m.hostname,
    room: await roomLabel(env, m.subnet),
    subnet: m.subnet,
    remote_ip: m.remote_ip,
    first_seen: m.first_seen,
    last_seen: m.last_seen,
    report: current,
    findings: compare(JSON.parse(m.baseline_json), current),
    alerts,
  });
}

async function subscribe(request, env) {
  const body = object(await readJson(request));
  const endpoint = reqStr(body, "endpoint");
  const keys = object(body.keys);
  if (Object.values(keys).some((v) => typeof v !== "string")) throw new HttpError(422, "keys must be strings");
  await env.DB.prepare("INSERT OR REPLACE INTO push_subscriptions (endpoint, data_json, created_at) VALUES (?, ?, ?)")
    .bind(endpoint, JSON.stringify({ endpoint, keys }), db.now()).run();
  return json({ ok: true });
}

/** 정해진 기간 동안 보고가 없는 PC를 찾아 알립니다. 크론 트리거로 하루 한 번 실행됩니다. */
export async function checkOverdue(env) {
  const { overdueDays } = settings(env);
  const rows = await db.all(
    env.DB,
    "SELECT m.machine_id, m.hostname, m.last_seen, COALESCE(r.name, m.subnet, '미분류') AS room"
    + " FROM machines m LEFT JOIN rooms r ON r.subnet = m.subnet"
    + " WHERE m.last_seen < ? AND m.overdue_alerted = 0",
    cutoff(overdueDays),
  );
  if (!rows.length) return [];
  const message = (r) => `${overdueDays}일 이상 보고 없음 (마지막 보고 ${r.last_seen.slice(0, 10)})`;
  await env.DB.batch(rows.flatMap((r) => [
    db.addAlert(env.DB, r.machine_id, "medium", message(r)),
    env.DB.prepare("UPDATE machines SET overdue_alerted = 1 WHERE machine_id = ?").bind(r.machine_id),
  ]));
  for (const r of rows) await notify(env, `⚠️ ${r.room} ${r.hostname} 연락 두절`, message(r), `/#pc=${r.machine_id}`);
  return rows.map((r) => r.machine_id);
}

// ---- 정적 파일 (대시보드 PWA, server/app/static) ----

async function asset(request, env, path, headers = {}) {
  const url = new URL(request.url);
  url.pathname = path;
  const res = await env.ASSETS.fetch(new Request(url, { method: request.method, headers: request.headers }));
  if (!res.ok || !Object.keys(headers).length) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

// ---- 라우팅 ----

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const admin = () => checkKey(env.PCGUARD_ADMIN_KEY, request.headers.get("X-Admin-Key"));
  let m;

  if (method === "POST" && path === "/api/report") return report(request, env, ctx);

  if (method === "GET" && path === "/api/dashboard") {
    await admin();
    return dashboard(env);
  }
  if (method === "GET" && path === "/api/machines") {
    await admin();
    return json(await db.all(env.DB, "SELECT machine_id, hostname, subnet, first_seen, last_seen FROM machines ORDER BY hostname"));
  }
  if (method === "GET" && (m = path.match(/^\/api\/machines\/([^/]+)$/))) {
    await admin();
    return machineDetail(env, decodeURIComponent(m[1]));
  }
  // 부품을 정상적으로 교체/이동했을 때 현재 구성을 새 기준으로 삼고 열린 알림을 닫습니다.
  if (method === "POST" && (m = path.match(/^\/api\/machines\/([^/]+)\/accept$/))) {
    await admin();
    if (!(await db.acceptBaseline(env.DB, decodeURIComponent(m[1])))) throw new HttpError(404, "unknown machine");
    return json({ ok: true });
  }
  if (method === "GET" && path === "/api/alerts") {
    await admin();
    const includeAck = ["true", "1", "yes", "on"].includes((url.searchParams.get("include_acknowledged") || "").toLowerCase());
    const sql = `SELECT * FROM alerts${includeAck ? "" : " WHERE acknowledged = 0"} ORDER BY id DESC`;
    return json(await db.all(env.DB, sql));
  }
  if (method === "POST" && (m = path.match(/^\/api\/alerts\/(\d+)\/ack$/))) {
    await admin();
    await env.DB.prepare("UPDATE alerts SET acknowledged = 1 WHERE id = ?").bind(Number(m[1])).run();
    return json({ ok: true });
  }
  if (method === "POST" && path === "/api/rooms") {
    await admin();
    const body = object(await readJson(request));
    await db.setRoomName(env.DB, reqStr(body, "subnet"), reqStr(body, "name").trim());
    return json({ ok: true });
  }

  if (method === "GET" && path === "/api/push/key") {
    return json({ public_key: vapidPublicKey(await loadVapid(env.DB)) });
  }
  if (method === "POST" && path === "/api/push/subscribe") {
    await admin();
    return subscribe(request, env);
  }
  if (method === "POST" && path === "/api/push/test") {
    await admin();
    await notify(env, "✅ PCGuard 알림 테스트", "이 기기에서 알림을 받을 수 있어요.");
    return json({ ok: true });
  }

  if (path.startsWith("/api/")) throw new HttpError(404, "Not Found");
  if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method Not Allowed");

  if (path === "/") return asset(request, env, "/");
  // 서비스 워커는 사이트 전체(/)를 다루도록 루트에서 제공해야 합니다.
  if (path === "/sw.js") return asset(request, env, "/sw.js", { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
  if (path === "/manifest.webmanifest") {
    return asset(request, env, path, { "Content-Type": "application/manifest+json" });
  }
  if (path.startsWith("/static/")) return asset(request, env, path.slice("/static".length));
  throw new HttpError(404, "Not Found");
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ detail: err.message }, err.status);
      console.error(err);
      return json({ detail: "Internal Server Error" }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(checkOverdue(env));
  },
};
