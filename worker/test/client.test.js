import assert from "node:assert/strict";
import { test } from "node:test";

import { checkOverdue } from "../src/index.js";
import { BASE, makeServer, withComponents } from "./helpers.js";

const KEY = { "X-Api-Key": "k" };
const ADMIN = { "X-Admin-Key": "a" };

async function clientCall(s, method, path, body, headers = KEY) {
  return s.request(method, path, { body, headers });
}

test("client status and memo", async () => {
  const s = makeServer();
  const status = async () => (await clientCall(s, "GET", "/api/client/status?machine_id=UUID-1")).json();
  assert.deepEqual(await status(), { registered: false });
  assert.equal((await clientCall(s, "POST", "/api/client/memo", { machine_id: "UUID-1", memo: "x" })).status, 404);
  await s.post(BASE);
  assert.equal((await clientCall(s, "POST", "/api/client/memo", { machine_id: "UUID-1", memo: "x" }, {})).status, 401);
  assert.equal((await clientCall(s, "POST", "/api/client/memo", { machine_id: "UUID-1", memo: "x".repeat(501) })).status, 422);
  await clientCall(s, "POST", "/api/client/memo", { machine_id: "UUID-1", memo: " 3열 5번 자리 " });

  const st = await status();
  assert.ok(st.registered);
  assert.equal(st.memo, "3열 5번 자리");
  assert.equal(st.room, "10.1.3.0/24");
  assert.deepEqual(st.disabled, []);
  const [m] = (await s.get("/api/dashboard")).rooms[0].machines;
  assert.equal(m.memo, "3열 5번 자리");
  const detail = await s.get("/api/machines/UUID-1");
  assert.equal(detail.memo, "3열 5번 자리");
  assert.ok(detail.memo_updated_at);

  // 비우면 메모 삭제
  await clientCall(s, "POST", "/api/client/memo", { machine_id: "UUID-1", memo: "" });
  assert.equal((await status()).memo, "");
});

test("client test alert is rate limited", async () => {
  const s = makeServer();
  await s.post(BASE);
  const r = await clientCall(s, "POST", "/api/client/test-alert", { machine_id: "UUID-1", message: "점검" });
  assert.equal(r.status, 200);
  assert.ok(s.sent[0][0].startsWith("🧪 [테스트]"));
  assert.match(s.sent[0][1], /점검/);
  // 연속으로 누르면 알림이 쏟아지지 않도록 막음
  assert.equal((await clientCall(s, "POST", "/api/client/test-alert", { machine_id: "UUID-1" })).status, 429);
  assert.equal(s.sent.length, 1);
  assert.equal((await clientCall(s, "POST", "/api/client/test-alert", { machine_id: "NOPE" })).status, 404);
  const d = await s.get("/api/dashboard");
  assert.equal(d.alerts[0].severity, "test");
  assert.equal(d.rooms[0].machines[0].status, "warning");
});

test("disable needs admin key and pauses alerts", async () => {
  const s = makeServer();
  await s.post(BASE);
  const body = { hours: 2, reason: "램 교체", disabled: ["startup_report"] };
  assert.equal((await clientCall(s, "POST", "/api/machines/UUID-1/disable", body)).status, 401);
  assert.equal((await s.adminPost("/api/machines/UUID-1/disable", { ...body, disabled: ["everything"] })).status, 422);
  assert.equal((await s.adminPost("/api/machines/UUID-1/disable", { ...body, hours: 1000 })).status, 422);
  assert.equal((await s.adminPost("/api/machines/NOPE/disable", body)).status, 404);
  assert.ok((await (await s.adminPost("/api/machines/UUID-1/disable", body)).json()).paused_until);

  const m = (await s.get("/api/dashboard")).rooms[0].machines[0];
  assert.equal(m.status, "paused");
  assert.deepEqual(m.disabled, ["startup_report"]);
  const detail = await s.get("/api/machines/UUID-1");
  assert.equal(detail.pause_reason, "램 교체");
  assert.ok(detail.paused_until);

  // 일시중지 중에는 부품이 빠져도 알리지 않음
  const noRam = withComponents(BASE.components.filter((c) => c.kind !== "ram"));
  await s.post(noRam);
  assert.equal(s.sent.length, 0);
  assert.deepEqual(await s.get("/api/alerts"), []);

  // 연락 두절 검사도 건너뜀
  await s.env.DB.prepare("UPDATE machines SET last_seen = ?").bind("2026-01-01T00:00:00+00:00").run();
  assert.deepEqual(await checkOverdue(s.env), []);

  // 해제하면 다음 보고에서 바로 알림
  await s.adminPost("/api/machines/UUID-1/disable", { hours: 0, disabled: [] });
  assert.equal((await s.post(noRam)).status, "alert");
  assert.equal(s.sent.length, 1);
});

test("offsite while paused alerts after the pause", async () => {
  const s = makeServer({ PCGUARD_SCHOOL_NETWORKS: "203.0.113.0/24" });
  await s.post(BASE, "203.0.113.10");
  await s.adminPost("/api/machines/UUID-1/disable", { hours: 2, reason: "수리 반출" });
  await s.post(BASE, "8.8.8.8");
  assert.equal(s.sent.length, 0);
  await s.adminPost("/api/machines/UUID-1/disable", { hours: 0 });
  await s.post(BASE, "8.8.8.8");
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0][1], /학교 밖/);
});
