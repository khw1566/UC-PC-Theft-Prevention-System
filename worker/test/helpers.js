// 테스트용: node:sqlite로 D1 API를 흉내 내고, Worker를 직접 호출합니다.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/index.js";

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Statement(this.db, this.sql, params.map((p) => (p === undefined ? null : p)));
  }

  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row ? { ...row } : null;
  }

  async all() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })) };
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

export class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  }

  prepare(sql) {
    return new Statement(this.db, sql);
  }

  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

const STATIC = new URL("../../server/app/static/", import.meta.url);

const fakeAssets = {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      const body = readFileSync(new URL(path === "/" ? "index.html" : path.slice(1), STATIC));
      return new Response(body, { headers: { "Content-Type": path.endsWith(".js") ? "application/javascript" : "text/html" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
};

/** 웹훅으로 나간 알림을 sent에 모으는 테스트 서버 */
export function makeServer(vars = {}) {
  const sent = [];
  const pushes = [];
  const pending = [];
  const env = {
    DB: new FakeD1(),
    ASSETS: fakeAssets,
    PCGUARD_API_KEY: "k",
    PCGUARD_ADMIN_KEY: "a",
    PCGUARD_WEBHOOK_URL: "https://hook.test/x",
    ...vars,
  };
  const ctx = { waitUntil: (p) => pending.push(p) };

  globalThis.fetch = async (url, init) => {
    if (String(url) === env.PCGUARD_WEBHOOK_URL) {
      const { text } = JSON.parse(init.body);
      const [title, ...rest] = text.split("\n");
      sent.push([title, rest.join("\n")]);
    } else {
      pushes.push({ url: String(url), init });
    }
    return new Response(null, { status: 201 });
  };

  async function request(method, path, { body, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    const res = await worker.fetch(new Request(`https://pcguard.test${path}`, init), env, ctx);
    await Promise.all(pending.splice(0));
    return res;
  }

  const admin = { "X-Admin-Key": "a" };
  return {
    env, sent, pushes, request,
    async post(report, ip = "203.0.113.10") {
      const res = await request("POST", "/api/report", { body: report, headers: { "X-Api-Key": "k", "CF-Connecting-IP": ip } });
      return res.json();
    },
    async get(path) {
      return (await request("GET", path, { headers: admin })).json();
    },
    async adminPost(path, body) {
      return request("POST", path, { body, headers: admin });
    },
  };
}

export const BASE = {
  machine_id: "UUID-1",
  hostname: "LAB-01",
  board_serial: "BOARD123",
  bios_serial: "BIOS123",
  network: [{ mac: "AA", ip: "10.1.3.21", mask: "255.255.255.0", gateway: "10.1.3.1" }],
  components: [
    { kind: "cpu", key: "BFEBFBFF000906EA", model: "Intel i5-9400" },
    { kind: "ram", key: "RAMSN1", model: "M378A", detail: "8 GB" },
    { kind: "ram", key: "RAMSN2", model: "M378A", detail: "8 GB" },
    { kind: "disk", key: "SSDSN1", model: "Samsung 860", detail: "256 GB" },
    { kind: "gpu", key: null, model: "NVIDIA GTX 1050" },
  ],
};

export function withComponents(components, extra = {}) {
  return { ...BASE, ...extra, components };
}
