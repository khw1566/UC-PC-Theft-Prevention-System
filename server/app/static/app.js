"use strict";

const KEY_STORAGE = "pcguard_admin_key";
const STATUS = {
  danger: "이상",
  warning: "주의",
  offline: "연락 두절",
  paused: "일시중지",
  ok: "정상",
};
const FEATURE = { startup_report: "시작 시 보고", weekly_report: "주간 보고" };
const KIND = { cpu: "CPU", ram: "메모리", disk: "저장장치", gpu: "그래픽카드", nic: "네트워크카드" };
const $ = (sel) => document.querySelector(sel);

let adminKey = storage("get");
let state = { data: null, filter: "all" };

function storage(op, value) {
  try {
    if (op === "get") return localStorage.getItem(KEY_STORAGE);
    if (op === "set") localStorage.setItem(KEY_STORAGE, value);
    if (op === "del") localStorage.removeItem(KEY_STORAGE);
  } catch (_) { /* 사파리 사생활 보호 모드 등 */ }
  return null;
}

// 보고서 값은 PC에서 오므로 innerHTML을 쓰지 않고 텍스트 노드로만 넣습니다.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey || "", ...(options.headers || {}) },
  });
  if (res.status === 401) {
    logout();
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function ago(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "방금";
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---- 로그인 ----

function showLogin() {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-key").focus();
}

function logout() {
  adminKey = null;
  storage("del");
  showLogin();
}

// 비밀번호(또는 처음 받은 관리자 키)로 로그인해 세션 토큰을 받아 둡니다.
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: $("#login-key").value }),
  });
  // Python 서버에는 /api/login이 없으므로 입력값을 관리자 키로 그대로 씁니다.
  if (res.status === 404) {
    adminKey = $("#login-key").value.trim();
    try {
      await api("/api/dashboard");
      storage("set", adminKey);
      $("#login-error").hidden = true;
      return start();
    } catch (_) {
      $("#login").hidden = false;
    }
  }
  if (!res.ok) {
    $("#login-error").textContent = res.status === 429
      ? "여러 번 틀려서 잠시 잠겼어요. 10분 뒤에 다시 해 주세요."
      : "비밀번호가 맞지 않아요.";
    $("#login-error").hidden = false;
    return;
  }
  adminKey = (await res.json()).token;
  storage("set", adminKey);
  $("#login-key").value = "";
  $("#login-error").hidden = true;
  start();
});
$("#logout-btn").addEventListener("click", () => {
  fetch("/api/logout", { method: "POST", headers: { "X-Admin-Key": adminKey || "" } }).catch(() => {});
  logout();
});

$("#password-btn").addEventListener("click", () => {
  $("#password-form").reset();
  $("#password-msg").hidden = true;
  $("#password-dialog").showModal();
});
$("#password-dialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget || e.target.closest("[data-close]")) $("#password-dialog").close();
});
$("#password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#password-msg");
  const next = $("#pw-new").value;
  msg.hidden = false;
  msg.className = "error";
  if (next !== $("#pw-confirm").value) {
    msg.textContent = "새 비밀번호 두 칸이 서로 달라요.";
    return;
  }
  const res = await fetch("/api/admin/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey || "" },
    body: JSON.stringify({ current_password: $("#pw-current").value, new_password: next }),
  });
  if (res.status === 401) return logout();
  if (!res.ok) {
    msg.textContent = res.status === 403 ? "현재 비밀번호가 맞지 않아요." : "새 비밀번호는 4자 이상 100자 이하로 정해 주세요.";
    return;
  }
  adminKey = (await res.json()).token;
  storage("set", adminKey);
  msg.className = "muted";
  msg.textContent = "바꿨어요. 다른 기기와 PC 관리 메뉴에서는 새 비밀번호로 다시 로그인하세요.";
  $("#password-form").reset();
});

// ---- 대시보드 ----

async function refresh() {
  try {
    state.data = await api("/api/dashboard");
    render();
  } catch (err) {
    if (err.message !== "unauthorized") $("#updated").textContent = "불러오기 실패, 다시 시도 중…";
  }
}

function allMachines() {
  return state.data.rooms.flatMap((r) => r.machines);
}

function render() {
  const { rooms, alerts } = state.data;
  const machines = allMachines();
  const counts = { all: machines.length, danger: 0, warning: 0, offline: 0, paused: 0, ok: 0 };
  machines.forEach((m) => counts[m.status]++);

  const stats = [
    ["all", "전체 PC", counts.all],
    ["danger", "이상", counts.danger],
    ["warning", "주의", counts.warning],
    ["offline", "연락 두절", counts.offline],
    ...(counts.paused ? [["paused", "일시중지", counts.paused]] : []),
  ];
  $("#summary").replaceChildren(
    ...stats.map(([key, label, n]) =>
      h("button", {
        type: "button",
        class: `stat ${key} ${state.filter === key ? "active" : ""}`,
        onclick: () => { state.filter = state.filter === key ? "all" : key; render(); },
      }, h("b", {}, n), h("span", {}, label))
    )
  );

  $("#alerts-section").hidden = alerts.length === 0;
  $("#alert-count").textContent = alerts.length;
  $("#alerts").replaceChildren(
    ...alerts.slice(0, 20).map((a) =>
      h("li", {},
        h("div", { class: "alert-where", onclick: () => openPc(a.machine_id) },
          h("span", { class: `sev ${a.severity}` }), `${a.room || "미분류"} · ${a.hostname}`),
        h("div", { class: "alert-msg" }, a.message),
        h("div", { class: "alert-time muted" }, fmtTime(a.created_at)),
        h("button", { type: "button", class: "btn small", onclick: (e) => ackAlert(a.id, e.currentTarget) }, "확인")
      )
    )
  );

  const visible = rooms
    .map((r) => ({ ...r, shown: r.machines.filter((m) => state.filter === "all" || m.status === state.filter) }))
    .filter((r) => r.shown.length || (state.filter === "all" && r.name));

  $("#rooms").replaceChildren(...visible.map(renderRoom));
  $("#empty").hidden = machines.length > 0;
  $("#updated").textContent = `${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 갱신`;
}

function renderRoom(room) {
  const tally = {};
  room.machines.forEach((m) => (tally[m.status] = (tally[m.status] || 0) + 1));
  const title = room.name || (room.subnet ? "이름 없는 호실" : "미분류");
  return h("article", { class: `room ${tally.danger ? "has-danger" : ""}` },
    h("div", { class: "room-head" },
      h("div", {},
        h("div", { class: "room-title" }, title),
        h("div", { class: "room-sub" }, room.subnet || "네트워크 정보 없음",
          room.subnet ? h("button", { type: "button", class: "btn small ghost", onclick: () => renameRoom(room) }, "✎ 이름") : null)
      ),
      h("div", { class: "room-counts" },
        ...["danger", "warning", "offline", "paused", "ok"]
          .filter((s) => tally[s])
          .map((s) => h("span", { class: `pill ${s}` }, `${STATUS[s]} ${tally[s]}`))
      )
    ),
    room.shown.length
      ? h("div", { class: "pcs" }, ...room.shown.map((m) =>
          h("button", { type: "button", class: `pc ${m.status}`, onclick: () => openPc(m.machine_id), title: STATUS[m.status] },
            h("b", {}, m.hostname || m.machine_id),
            h("span", {}, m.status === "ok" ? ago(m.last_seen) : STATUS[m.status]),
            h("span", {}, m.ip || ""),
            m.memo ? h("span", { class: "memo" }, `📝 ${m.memo}`) : null,
            m.disabled?.length ? h("span", {}, `🔕 ${m.disabled.map((f) => FEATURE[f] || f).join(", ")} 꺼짐`) : null
          )))
      : h("p", { class: "muted" }, "이 호실에서 보고한 PC가 없어요.")
  );
}

async function renameRoom(room) {
  const name = prompt(`${room.subnet} 망의 호실 이름 (예: 301호 컴퓨터실)\n비우면 이름을 지워요.`, room.name || "");
  if (name === null) return;
  await api("/api/rooms", { method: "POST", body: JSON.stringify({ subnet: room.subnet, name }) });
  refresh();
}

async function ackAlert(id, btn) {
  btn.disabled = true;
  await api(`/api/alerts/${id}/ack`, { method: "POST" });
  refresh();
}

// ---- PC 상세 ----

async function openPc(machineId) {
  const dialog = $("#pc-dialog");
  const summary = allMachines().find((m) => m.machine_id === machineId);
  $("#pc-title").textContent = summary?.hostname || machineId;
  $("#pc-body").replaceChildren(h("p", { class: "muted" }, "불러오는 중…"));
  if (!dialog.open) dialog.showModal();
  history.replaceState(null, "", `#pc=${encodeURIComponent(machineId)}`);

  let d;
  try {
    d = await api(`/api/machines/${encodeURIComponent(machineId)}`);
  } catch (_) {
    $("#pc-body").replaceChildren(h("p", { class: "error" }, "PC 정보를 불러오지 못했어요."));
    return;
  }
  const r = d.report;
  const status = summary?.status || "ok";
  const byKind = {};
  (r.components || []).forEach((c) => (byKind[c.kind] = byKind[c.kind] || []).push(c));
  const alerts = d.findings.filter((f) => f.severity !== "info");

  $("#pc-title").textContent = d.hostname || machineId;
  // 조건에 맞지 않는 칸(null)은 빼고 넣습니다.
  $("#pc-body").replaceChildren(...[
    h("div", { class: `status-banner ${status}` },
      status === "ok" ? "정상: 처음 등록한 구성과 같아요."
        : status === "paused" ? `일시중지: ${fmtTime(d.paused_until)}까지 이 PC의 알림을 보내지 않아요.`
        : `${STATUS[status]}: ${alerts.length ? `기준과 다른 점 ${alerts.length}개` : summary?.open_alerts ? `확인할 알림 ${summary.open_alerts}개` : `${state.data.overdue_days}일 넘게 보고가 없어요`}`),
    d.findings.length
      ? h("ul", { class: "findings" }, ...d.findings.map((f) => h("li", {}, h("span", { class: `sev ${f.severity}` }), f.message)))
      : null,
    h("h4", {}, "기본 정보"),
    h("dl", { class: "kv" },
      ...[
        ["관리자 메모", d.memo && `${d.memo} (${fmtTime(d.memo_updated_at)})`],
        ["알림 일시중지", d.paused_until && `${fmtTime(d.paused_until)}까지${d.pause_reason ? ` · ${d.pause_reason}` : ""}`],
        ["꺼진 기능", d.disabled?.length && d.disabled.map((f) => FEATURE[f] || f).join(", ")],
        ["호실", `${d.room}${d.subnet && d.room !== d.subnet ? ` (${d.subnet})` : ""}`],
        ["IP", (r.network || []).map((n) => n.ip).join(", ") || d.remote_ip],
        ["접속 IP", d.remote_ip],
        ["모델", [r.manufacturer, r.product].filter(Boolean).join(" ")],
        ["OS", r.os],
        ["메인보드 S/N", r.board_serial],
        ["BIOS S/N", r.bios_serial],
        ["마지막 보고", `${fmtTime(d.last_seen)} (${ago(d.last_seen)})`],
        ["처음 등록", fmtTime(d.first_seen)],
        ["UUID", d.machine_id],
      ].filter(([, v]) => v).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])
    ),
    h("h4", {}, "현재 부품"),
    h("table", {},
      h("tr", {}, h("th", {}, "종류"), h("th", {}, "모델"), h("th", {}, "일련번호")),
      ...Object.entries(byKind).flatMap(([kind, list]) =>
        list.map((c) => h("tr", {}, h("td", {}, KIND[kind] || kind), h("td", {}, [c.model, c.detail].filter(Boolean).join(" · ")), h("td", {}, c.key || "-")))
      )
    ),
    d.alerts.length ? h("h4", {}, "알림 기록") : null,
    d.alerts.length
      ? h("ul", { class: "findings" }, ...d.alerts.map((a) =>
          h("li", {}, h("span", { class: `sev ${a.severity}` }), `${fmtTime(a.created_at)} ${a.message}`, a.acknowledged ? h("span", { class: "muted" }, " (확인됨)") : null)))
      : null,
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn", onclick: (e) => identifyPc(machineId, 300, e.currentTarget) },
        d.identify_until ? `PC 화면 표시 중 (${fmtTime(d.identify_until)}까지) · 다시 보내기` : "이 PC 화면에 식별 창 띄우기 (5분)"),
      d.identify_until
        ? h("button", { type: "button", class: "btn", onclick: (e) => identifyPc(machineId, 0, e.currentTarget) }, "식별 창 끄기")
        : null,
      d.findings.length || summary?.open_alerts
        ? h("button", { type: "button", class: "btn primary", onclick: () => acceptPc(machineId) }, "현재 구성을 정상으로 승인")
        : null,
      d.paused_until
        ? h("button", { type: "button", class: "btn", onclick: () => resumePc(machineId, d.disabled) }, "알림 일시중지 해제")
        : null
    )
  ].filter(Boolean));
}

// PC의 작업표시줄 아이콘이 1분마다 확인하므로 창은 최대 1분 안에 뜹니다.
async function identifyPc(machineId, seconds, btn) {
  btn.disabled = true;
  try {
    await api(`/api/machines/${encodeURIComponent(machineId)}/identify`, { method: "POST", body: JSON.stringify({ seconds }) });
    if (seconds) alert("보냈어요. 1분 안에 그 PC 화면에 빨간 식별 창이 떠요.");
  } catch (_) {
    alert("보내지 못했어요. 잠시 뒤 다시 해 주세요.");
  }
  openPc(machineId);
}

async function resumePc(machineId, disabled) {
  await api(`/api/machines/${encodeURIComponent(machineId)}/disable`, { method: "POST", body: JSON.stringify({ hours: 0, disabled }) });
  openPc(machineId);
  refresh();
}

async function acceptPc(machineId) {
  if (!confirm("부품 교체나 자리 이동이 정상적인 것이었나요?\n지금 구성을 새 기준으로 저장하고 이 PC의 알림을 모두 확인 처리해요.")) return;
  await api(`/api/machines/${encodeURIComponent(machineId)}/accept`, { method: "POST" });
  $("#pc-dialog").close();
  refresh();
}

$("#pc-dialog").addEventListener("close", () => history.replaceState(null, "", location.pathname));
$("#pc-dialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget || e.target.closest("[data-close]")) $("#pc-dialog").close();
});

function openFromHash() {
  const m = location.hash.match(/^#pc=(.+)$/);
  if (m) openPc(decodeURIComponent(m[1]));
}
window.addEventListener("hashchange", openFromHash);

// ---- 웹 푸시 ----

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function b64ToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function setupPushButton() {
  const btn = $("#push-btn");
  const hint = $("#push-hint");
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  if (!supported) {
    btn.hidden = true;
    if (isIOS && !isStandalone) {
      hint.textContent = "아이폰에서 알림을 받으려면 공유 버튼 → '홈 화면에 추가'로 앱을 설치한 뒤 거기서 열어 주세요.";
      hint.hidden = false;
    }
    return;
  }
  const reg = await navigator.serviceWorker.register("/sw.js");
  const sub = await reg.pushManager.getSubscription();
  if (sub && Notification.permission === "granted") {
    btn.textContent = "🔔 알림 켜짐";
    // 서버 DB가 바뀌어도 이 기기 구독이 남도록 다시 등록해 둡니다.
    api("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub) }).catch(() => {});
  }
  btn.onclick = () => enablePush(reg);
}

async function enablePush(reg) {
  const btn = $("#push-btn");
  btn.disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      alert("알림이 차단되어 있어요. 브라우저 설정에서 이 사이트의 알림을 허용해 주세요.");
      return;
    }
    const { public_key } = await fetch("/api/push/key").then((r) => r.json());
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(public_key) });
    await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub) });
    await api("/api/push/test", { method: "POST" });
    btn.textContent = "🔔 알림 켜짐";
  } catch (err) {
    alert(`알림을 켜지 못했어요: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---- 시작 ----

let timer;
async function start() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  await refresh();
  openFromHash();
  setupPushButton().catch(() => {});
  clearInterval(timer);
  timer = setInterval(refresh, 30000);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && adminKey) refresh();
});

if (adminKey) start();
else showLogin();
