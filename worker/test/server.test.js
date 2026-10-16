import assert from "node:assert/strict";
import { test } from "node:test";

import { checkOverdue } from "../src/index.js";
import { BASE, makeServer, withComponents } from "./helpers.js";

test("rejects bad key", async () => {
  const s = makeServer();
  const res = await s.request("POST", "/api/report", { body: BASE, headers: { "X-Api-Key": "nope" } });
  assert.equal(res.status, 401);
  assert.equal((await s.request("GET", "/api/dashboard")).status, 401);
});

test("rejects malformed report", async () => {
  const s = makeServer();
  const res = await s.request("POST", "/api/report", { body: { hostname: "x" }, headers: { "X-Api-Key": "k" } });
  assert.equal(res.status, 422);
});

test("flow: register, alert, dedupe, accept", async () => {
  const s = makeServer();
  assert.equal((await s.post(BASE)).status, "registered");
  assert.equal((await s.post(BASE)).status, "ok");

  const stolen = withComponents(BASE.components.filter((c) => c.kind !== "ram"));
  const r = await s.post(stolen);
  assert.equal(r.status, "alert");
  assert.equal(r.alerts.length, 2);
  assert.equal(s.sent.length, 1);

  // 같은 상태로 다시 보고해도 알림은 다시 보내지 않음
  await s.post(stolen);
  assert.equal(s.sent.length, 1);

  assert.equal((await s.get("/api/alerts")).length, 2);
  assert.equal((await s.adminPost("/api/machines/UUID-1/accept")).status, 200);
  assert.equal((await s.get("/api/alerts")).length, 0);
  assert.equal((await s.get("/api/alerts?include_acknowledged=true")).length, 2);
  assert.equal((await s.post(stolen)).status, "ok");
  assert.equal((await s.adminPost("/api/machines/NOPE/accept")).status, 404);
});

test("overdue alerts once", async () => {
  const s = makeServer();
  await s.post(BASE);
  const old = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
  await s.env.DB.prepare("UPDATE machines SET last_seen = ?").bind(old).run();
  assert.deepEqual(await checkOverdue(s.env), ["UUID-1"]);
  assert.deepEqual(await checkOverdue(s.env), []);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0][0], /연락 두절/);
  const d = await s.get("/api/dashboard");
  assert.equal(d.rooms[0].machines[0].status, "offline");
});

test("dashboard groups by room", async () => {
  const s = makeServer();
  await s.post(BASE);
  await s.post({ ...BASE, machine_id: "UUID-2", hostname: "LAB-02" });
  await s.post({ ...BASE, machine_id: "UUID-3", hostname: "T-01",
    network: [{ ip: "10.2.0.9", mask: "255.255.255.0", gateway: "10.2.0.1" }] });
  await s.adminPost("/api/rooms", { subnet: "10.1.3.0/24", name: "301호" });
  await s.post(withComponents(BASE.components.filter((c) => c.kind !== "disk")));

  let d = await s.get("/api/dashboard");
  assert.deepEqual(d.rooms.map((r) => r.subnet), ["10.1.3.0/24", "10.2.0.0/24"]);
  const rooms = Object.fromEntries(d.rooms.map((r) => [r.subnet, r]));
  assert.equal(rooms["10.1.3.0/24"].name, "301호");
  assert.deepEqual(
    Object.fromEntries(rooms["10.1.3.0/24"].machines.map((m) => [m.hostname, m.status])),
    { "LAB-01": "danger", "LAB-02": "ok" },
  );
  assert.equal(rooms["10.1.3.0/24"].machines[0].ip, "10.1.3.21");
  assert.deepEqual(rooms["10.2.0.0/24"].machines.map((m) => m.hostname), ["T-01"]);
  assert.equal(d.alerts[0].room, "301호");
  assert.equal(d.alerts[0].hostname, "LAB-01");
  assert.ok(s.sent[0][0].startsWith("🚨 301호 LAB-01"));

  const detail = await s.get("/api/machines/UUID-1");
  assert.equal(detail.room, "301호");
  assert.ok(detail.findings.length);
  assert.equal((await s.request("GET", "/api/machines/NOPE", { headers: { "X-Admin-Key": "a" } })).status, 404);

  await s.adminPost("/api/machines/UUID-1/accept");
  d = await s.get("/api/dashboard");
  assert.deepEqual(d.alerts, []);

  // 이름을 비우면 호실 이름이 지워짐
  await s.adminPost("/api/rooms", { subnet: "10.1.3.0/24", name: "  " });
  assert.equal((await s.get("/api/dashboard")).rooms[0].name, null);
});

test("offsite alerts once until back at school", async () => {
  const s = makeServer({ PCGUARD_SCHOOL_NETWORKS: "203.0.113.0/24" });
  assert.equal((await s.post(BASE, "203.0.113.10")).status, "registered");
  assert.equal((await s.post(BASE, "203.0.113.10")).status, "ok");

  const r = await s.post(BASE, "8.8.8.8");
  assert.equal(r.status, "alert");
  assert.match(r.alerts[0], /8\.8\.8\.8/);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0][1], /학교 밖/);

  // 밖에 있는 동안 쌓인 보고가 계속 와도 알림은 한 번만
  assert.equal((await s.post(BASE, "8.8.4.4")).status, "alert");
  assert.equal(s.sent.length, 1);

  assert.deepEqual((await s.get("/api/alerts")).map((a) => a.severity), ["high"]);
  assert.equal((await s.get("/api/dashboard")).rooms[0].machines[0].status, "danger");

  // 학교로 돌아오면 다시 감시하고, 또 나가면 다시 알림
  assert.equal((await s.post(BASE, "203.0.113.10")).status, "ok");
  await s.post(BASE, "8.8.8.8");
  assert.equal(s.sent.length, 2);
});

test("offsite check off without school networks", async () => {
  const s = makeServer();
  await s.post(BASE);
  const r = await s.post(BASE, "8.8.8.8");
  assert.equal(r.status, "ok");
  assert.equal(s.sent.length, 0);
});

test("offsite with missing parts alerts each once", async () => {
  const s = makeServer({ PCGUARD_SCHOOL_NETWORKS: "203.0.113.0/24" });
  await s.post(BASE, "203.0.113.10");
  const r = await s.post(withComponents(BASE.components.filter((c) => c.kind !== "disk")), "8.8.8.8");
  assert.equal(r.alerts.length, 2);
  assert.equal((await s.get("/api/alerts")).length, 2);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0][1].split("\n").length, 2);
});

test("single-element arrays from PowerShell are accepted", async () => {
  const s = makeServer();
  const report = { ...BASE, components: BASE.components[0], network: BASE.network[0] };
  assert.equal((await s.post(report)).status, "registered");
  const detail = await s.get("/api/machines/UUID-1");
  assert.equal(detail.report.components.length, 1);
  assert.equal(detail.room, "10.1.3.0/24");
});

test("dashboard page and assets are served", async () => {
  const s = makeServer();
  assert.match(await (await s.request("GET", "/")).text(), /PCGuard/);
  const sw = await s.request("GET", "/sw.js");
  assert.ok(sw.headers.get("content-type").startsWith("text/javascript"));
  assert.equal(sw.headers.get("cache-control"), "no-cache");
  assert.equal((await s.request("GET", "/static/app.js")).status, 200);
  assert.equal((await s.request("GET", "/manifest.webmanifest")).headers.get("content-type"), "application/manifest+json");
  assert.equal((await s.request("GET", "/api/nope")).status, 404);
});
