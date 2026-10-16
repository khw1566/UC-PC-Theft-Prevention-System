import assert from "node:assert/strict";
import { test } from "node:test";

import { b64urlDecode, b64urlEncode } from "../src/webpush.js";
import { makeServer } from "./helpers.js";

const subtle = crypto.subtle;

// 브라우저 쪽 역할: 구독 키를 만들고 받은 푸시를 복호화합니다 (RFC 8291).
async function browserSubscription() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return {
    pair, auth, p256dh,
    json: { endpoint: "https://push.example/abc", expirationTime: null, keys: { p256dh: b64urlEncode(p256dh), auth: b64urlEncode(auth) } },
  };
}

async function hkdf(salt, ikm, info, len) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

async function decrypt(sub, body) {
  const enc = new TextEncoder();
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const asPublic = body.slice(21, 21 + idLen);
  const cipher = body.slice(21 + idLen);
  const asKey = await subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, sub.pair.privateKey, 256));
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...sub.p256dh, ...asPublic]);
  const ikm = await hkdf(sub.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher));
  assert.equal(plain[plain.length - 1], 2);
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

test("push key is stable and subscribe needs admin", async () => {
  const s = makeServer();
  const { public_key: key } = await (await s.request("GET", "/api/push/key")).json();
  assert.equal(key.length, 87); // 65바이트 비압축 P-256 공개키의 base64url
  assert.equal((await (await s.request("GET", "/api/push/key")).json()).public_key, key);
  const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "x", auth: "y" } };
  assert.equal((await s.request("POST", "/api/push/subscribe", { body: sub })).status, 401);
  assert.equal((await s.adminPost("/api/push/subscribe", sub)).status, 200);
});

test("test push is encrypted for the browser and signed with VAPID", async () => {
  const s = makeServer();
  const sub = await browserSubscription();
  assert.equal((await s.adminPost("/api/push/subscribe", sub.json)).status, 200);
  const { public_key: vapidKey } = await (await s.request("GET", "/api/push/key")).json();

  assert.equal((await s.adminPost("/api/push/test")).status, 200);
  assert.equal(s.pushes.length, 1);
  const { url, init } = s.pushes[0];
  assert.equal(url, "https://push.example/abc");
  assert.equal(init.headers["Content-Encoding"], "aes128gcm");
  assert.equal(init.headers.Urgency, "high");

  const message = await decrypt(sub, new Uint8Array(init.body));
  assert.equal(message.title, "✅ PCGuard 알림 테스트");
  assert.equal(message.url, "/");

  // VAPID JWT 서명을 공개키로 검증
  const [, token, k] = init.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, vapidKey);
  const [h, c, sig] = token.split(".");
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
  assert.equal(claims.aud, "https://push.example");
  assert.equal(claims.sub, "mailto:admin@audreaming.com");
  const pub = await subtle.importKey("raw", b64urlDecode(vapidKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64urlDecode(sig), new TextEncoder().encode(`${h}.${c}`));
  assert.ok(ok);
});

test("expired subscriptions are removed", async () => {
  const s = makeServer();
  const sub = await browserSubscription();
  await s.adminPost("/api/push/subscribe", sub.json);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith("https://push.example") ? new Response(null, { status: 410 }) : realFetch(url, init));
  await s.adminPost("/api/push/test");
  const { results } = await s.env.DB.prepare("SELECT * FROM push_subscriptions").all();
  assert.equal(results.length, 0);
});
