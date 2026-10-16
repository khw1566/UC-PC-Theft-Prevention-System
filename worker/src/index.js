// PCGuard 감시 서버 (Cloudflare Workers + D1). server/app/main.py와 같은 API를 제공합니다.
import * as auth from "./auth.js";
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

function maxLen(value, field, n) {
  if (value.length > n) throw new HttpError(422, `${field} must be at most ${n} characters`);
  return value;
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
  let sig = findings.length ? await sha256Hex(findings.map((f) => f.message).join("\n")) : null;

  // 점검(일시중지) 중에는 알리지 않고, 서명도 그대로 둬서 끝난 뒤 첫 보고에서 알립니다.
  const paused = db.isPaused(machine);
  if (paused) sig = machine.last_alert_sig;

  // 같은 변경이 매주 반복 보고돼도 알림은 처음 한 번만 보냅니다.
  const newAlerts = sig !== machine.last_alert_sig ? [...alerts] : [];

  // 학교 밖에서 켜졌다면 PC째 반출된 것일 수 있으므로 바로 알립니다.
  // 다시 학교 안에서 보고할 때까지는 한 번만 알립니다.
  const offsite = outsideSchool(remoteIp, settings(env).schoolNetworks);
  if (offsite) {
    const finding = { severity: "high", message: `학교 밖 네트워크에서 켜짐 (접속 IP ${remoteIp})` };
    alerts.push(finding);
    if (!machine.offsite_alerted && !paused) newAlerts.push(finding);
  }

  await env.DB.batch([
    ...newAlerts.map((f) => db.addAlert(env.DB, data.machine_id, f.severity, f.message)),
    // 일시중지 중에 밖에 있었다면 끝난 뒤 첫 보고에서 알리도록 표시하지 않습니다.
    db.updateLastReport(env.DB, data, sig, subnet, remoteIp, offsite && (!paused || Boolean(machine.offsite_alerted))),
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

// ---- 클라이언트 메뉴 (PC의 관리 메뉴 GUI) ----

// 클라이언트 메뉴에서 끌 수 있는 기능
const DISABLE_FEATURES = new Set(["startup_report", "weekly_report"]);
const TEST_ALERT_INTERVAL_MS = 30 * 1000;
const IDENTIFY_DEFAULT_SECONDS = 5 * 60;

async function requireMachine(env, machineId) {
  const m = await db.getMachine(env.DB, machineId);
  if (!m) throw new HttpError(404, "unknown machine");
  return m;
}

async function clientStatus(env, machineId) {
  if (!machineId) throw new HttpError(422, "machine_id is required");
  const m = await db.getMachine(env.DB, machineId);
  if (!m) return json({ registered: false });
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE machine_id = ? AND acknowledged = 0")
    .bind(machineId).first();
  return json({
    registered: true,
    hostname: m.hostname,
    room: await roomLabel(env, m.subnet),
    last_seen: m.last_seen,
    open_alerts: n,
    memo: m.memo || "",
    paused_until: db.isPaused(m) ? m.paused_until : null,
    disabled: JSON.parse(m.disabled_json),
  });
}

async function clientMemo(request, env) {
  const body = object(await readJson(request));
  const memo = maxLen(optStr(body, "memo") ?? "", "memo", 500).trim();
  if (!(await db.setMemo(env.DB, reqStr(body, "machine_id"), memo))) throw new HttpError(404, "unknown machine");
  return json({ ok: true });
}

async function clientTestAlert(request, env, ctx) {
  const body = object(await readJson(request));
  const machineId = reqStr(body, "machine_id");
  const extra = maxLen(optStr(body, "message") ?? "", "message", 200).trim();
  const m = await requireMachine(env, machineId);
  // 연속으로 누르면 알림이 쏟아지지 않도록 막습니다.
  const recent = await env.DB.prepare("SELECT 1 FROM alerts WHERE machine_id = ? AND severity = 'test' AND created_at > ?")
    .bind(machineId, db.now(new Date(Date.now() - TEST_ALERT_INTERVAL_MS))).first();
  if (recent) throw new HttpError(429, "test alert sent too recently");
  const message = `[테스트] 도난 알림 테스트${extra ? `: ${extra}` : ""}`;
  await db.addAlert(env.DB, machineId, "test", message).run();
  ctx.waitUntil(notify(env, `🧪 [테스트] ${await roomLabel(env, m.subnet)} ${m.hostname} 도난 알림`, message, `/#pc=${machineId}`));
  return json({ ok: true });
}

/** 점검·수리 중인 PC의 서버 알림을 잠시 멈추고, PC에서 끈 기능을 기록합니다. */
async function disable(request, env, machineId) {
  const body = object(await readJson(request));
  const hours = body.hours ?? 0;
  if (typeof hours !== "number" || !(hours >= 0 && hours <= 24 * 30)) throw new HttpError(422, "hours must be between 0 and 720");
  const reason = maxLen(optStr(body, "reason") ?? "", "reason", 200).trim();
  const disabled = list(body.disabled);
  const unknown = disabled.filter((f) => !DISABLE_FEATURES.has(f));
  if (unknown.length) throw new HttpError(422, `unknown features: ${JSON.stringify(unknown.sort())}`);
  const until = hours > 0 ? db.now(new Date(Date.now() + hours * 3600 * 1000)) : null;
  if (!(await db.setDisabled(env.DB, machineId, until, reason, [...new Set(disabled)].sort()))) {
    throw new HttpError(404, "unknown machine");
  }
  return json({ ok: true, paused_until: until });
}

// ---- 대시보드 ----

function machineStatus(row, openAlerts, since) {
  if (openAlerts.some((a) => a.severity === "high")) return "danger";
  if (db.isPaused(row)) return "paused";
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
      memo: m.memo,
      disabled: JSON.parse(m.disabled_json),
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
    memo: m.memo,
    memo_updated_at: m.memo_updated_at,
    paused_until: db.isPaused(m) ? m.paused_until : null,
    pause_reason: m.pause_reason,
    disabled: JSON.parse(m.disabled_json),
    identify_until: activeIdentify(m) ? m.identify_until : null,
    report: current,
    findings: compare(JSON.parse(m.baseline_json), current),
    alerts,
  });
}

// ---- PC 식별 창 ----

function activeIdentify(m) {
  return Boolean(m.identify_until) && m.identify_until > db.now();
}

/** 대시보드에서 누르면 해당 PC 화면에 seconds초 동안 눈에 띄는 식별 창을 띄웁니다 (0이면 끄기). */
async function identify(request, env, machineId) {
  const body = object(await readJson(request));
  const seconds = body.seconds ?? IDENTIFY_DEFAULT_SECONDS;
  if (typeof seconds !== "number" || !(seconds >= 0 && seconds <= 3600)) throw new HttpError(422, "seconds must be between 0 and 3600");
  const message = maxLen(optStr(body, "message") ?? "", "message", 200).trim();
  const until = seconds > 0 ? db.now(new Date(Date.now() + seconds * 1000)) : null;
  const res = await env.DB.prepare("UPDATE machines SET identify_until = ?, identify_message = ? WHERE machine_id = ?")
    .bind(until, message || null, machineId).run();
  if (!res.meta.changes) throw new HttpError(404, "unknown machine");
  return json({ ok: true, identify_until: until });
}

/**
 * PC의 작업표시줄 아이콘이 주기적으로 묻는 식별 요청. 키 없이 열려 있으므로
 * 식별 창에 띄울 내용(호실, 이름, 메시지)만 돌려주고 부품 정보나 메모는 주지 않습니다.
 */
async function identifyPoll(env, machineId) {
  if (!machineId) throw new HttpError(422, "machine_id is required");
  const m = await db.getMachine(env.DB, machineId);
  if (!m || !activeIdentify(m)) return json({ active: false });
  return json({
    active: true,
    until: m.identify_until,
    hostname: m.hostname,
    room: await roomLabel(env, m.subnet),
    message: m.identify_message || "",
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
    + " WHERE m.last_seen < ? AND m.overdue_alerted = 0"
    + " AND (m.paused_until IS NULL OR m.paused_until <= ?)",
    cutoff(overdueDays),
    db.now(),
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

// 안드로이드 앱(android/)이 이 사이트를 주소창 없이 열도록 허용하는 Digital Asset Links.
// PCGUARD_ANDROID_CERT_SHA256에는 앱 서명 키의 SHA-256 지문을 쉼표로 구분해 적습니다.
function assetLinks(env) {
  const fingerprints = (env.PCGUARD_ANDROID_CERT_SHA256 || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!fingerprints.length) return [];
  return [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: env.PCGUARD_ANDROID_PACKAGE || "com.audreaming.pcguard",
      sha256_cert_fingerprints: fingerprints,
    },
  }];
}

// ---- 라우팅 ----

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const admin = async () => {
    if (!(await auth.isAdmin(env, request.headers.get("X-Admin-Key")))) throw new HttpError(401, "invalid key");
  };
  let m;

  if (method === "POST" && path === "/api/report") return report(request, env, ctx);
  if (method === "GET" && path === "/api/identify") return identifyPoll(env, url.searchParams.get("machine_id"));

  // 관리자 로그인: 처음 키 또는 대시보드에서 바꾼 비밀번호로 세션 토큰을 받습니다.
  if (method === "POST" && path === "/api/login") {
    const body = object(await readJson(request));
    const res = await auth.login(env, typeof body.password === "string" ? body.password : "");
    if (res.error === "locked") throw new HttpError(429, "too many failed attempts, try again later");
    if (res.error) throw new HttpError(401, "invalid password");
    return json(res);
  }
  if (method === "POST" && path === "/api/logout") {
    await auth.logout(env, request.headers.get("X-Admin-Key"));
    return json({ ok: true });
  }
  if (method === "POST" && path === "/api/admin/password") {
    await admin();
    const body = object(await readJson(request));
    const next = reqStr(body, "new_password");
    if (next.length < 4 || next.length > 100) throw new HttpError(422, "new_password must be 4 to 100 characters");
    const current = typeof body.current_password === "string" ? body.current_password : "";
    const res = await auth.changePassword(env, current, next);
    if (res.error) throw new HttpError(403, "current password is wrong");
    return json(res);
  }

  if (path.startsWith("/api/client/")) {
    await checkKey(env.PCGUARD_API_KEY, request.headers.get("X-Api-Key"));
    if (method === "GET" && path === "/api/client/status") return clientStatus(env, url.searchParams.get("machine_id"));
    if (method === "POST" && path === "/api/client/memo") return clientMemo(request, env);
    if (method === "POST" && path === "/api/client/test-alert") return clientTestAlert(request, env, ctx);
  }

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
  if (method === "POST" && (m = path.match(/^\/api\/machines\/([^/]+)\/identify$/))) {
    await admin();
    return identify(request, env, decodeURIComponent(m[1]));
  }
  if (method === "POST" && (m = path.match(/^\/api\/machines\/([^/]+)\/disable$/))) {
    await admin();
    return disable(request, env, decodeURIComponent(m[1]));
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
  if (path === "/.well-known/assetlinks.json") return json(assetLinks(env));
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
