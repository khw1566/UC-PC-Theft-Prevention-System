import assert from "node:assert/strict";
import { test } from "node:test";

import { BASE, makeServer } from "./helpers.js";

async function login(s, password) {
  return s.request("POST", "/api/login", { body: { password } });
}

test("master key logs in and its token works as the admin key", async () => {
  const s = makeServer();
  assert.equal((await login(s, "wrong")).status, 401);
  const { token } = await (await login(s, "a")).json();
  const res = await s.request("GET", "/api/dashboard", { headers: { "X-Admin-Key": token } });
  assert.equal(res.status, 200);
});

test("password can be changed from the dashboard", async () => {
  const s = makeServer();
  const change = (headers, body) => s.request("POST", "/api/admin/password", { headers, body });
  assert.equal((await change({ "X-Admin-Key": "a" }, { current_password: "bad", new_password: "1234" })).status, 403);
  assert.equal((await change({ "X-Admin-Key": "a" }, { current_password: "a", new_password: "12" })).status, 422);
  assert.equal((await change({}, { current_password: "a", new_password: "1234" })).status, 401);

  const { token } = await (await change({ "X-Admin-Key": "a" }, { current_password: "a", new_password: "1234" })).json();
  assert.equal((await s.request("GET", "/api/dashboard", { headers: { "X-Admin-Key": token } })).status, 200);
  assert.equal((await login(s, "1234")).status, 200);
  assert.equal((await login(s, "123")).status, 401);
  // 처음 키는 비밀번호를 잊었을 때를 위해 계속 쓸 수 있음
  assert.equal((await login(s, "a")).status, 200);

  // 비밀번호를 바꾸면 다른 기기 로그인은 풀림
  const old = token;
  await change({ "X-Admin-Key": "a" }, { current_password: "1234", new_password: "5678" });
  assert.equal((await s.request("GET", "/api/dashboard", { headers: { "X-Admin-Key": old } })).status, 401);
});

test("repeated wrong passwords lock login except for the master key", async () => {
  const s = makeServer();
  for (let i = 0; i < 10; i++) await login(s, "nope");
  assert.equal((await login(s, "nope")).status, 429);
  assert.equal((await login(s, "a")).status, 200);
});

test("logout revokes the session token", async () => {
  const s = makeServer();
  const { token } = await (await login(s, "a")).json();
  await s.request("POST", "/api/logout", { headers: { "X-Admin-Key": token } });
  assert.equal((await s.request("GET", "/api/dashboard", { headers: { "X-Admin-Key": token } })).status, 401);
});

test("identify window request reaches the PC and expires", async () => {
  const s = makeServer();
  await s.post(BASE);
  const poll = async () => (await s.request("GET", "/api/identify?machine_id=UUID-1")).json();
  assert.deepEqual(await poll(), { active: false });

  assert.equal((await s.adminPost("/api/machines/UUID-1/identify", { seconds: 60, message: "자리 확인" })).status, 200);
  const p = await poll();
  assert.equal(p.active, true);
  assert.equal(p.message, "자리 확인");
  assert.equal(p.hostname, BASE.hostname);
  assert.ok((await s.get("/api/machines/UUID-1")).identify_until);

  await s.adminPost("/api/machines/UUID-1/identify", { seconds: 0 });
  assert.deepEqual(await poll(), { active: false });
  assert.equal((await s.adminPost("/api/machines/NOPE/identify", {})).status, 404);
  assert.equal((await s.adminPost("/api/machines/UUID-1/identify", { seconds: 99999 })).status, 422);
});
