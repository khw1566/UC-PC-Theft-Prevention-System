// 관리자 인증: 처음 배포 때 넣은 PCGUARD_ADMIN_KEY 또는 대시보드에서 바꾼 비밀번호로 로그인해
// 세션 토큰을 받습니다. 대시보드와 PC 관리 메뉴는 이 토큰을 X-Admin-Key 헤더로 보냅니다.
import * as db from "./db.js";

const PBKDF2_ITERATIONS = 10000; // Workers 무료 플랜 CPU 한도 안에서 도는 값
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const LOCK_MINUTES = 10;

const enc = new TextEncoder();

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(n) {
  return toHex(crypto.getRandomValues(new Uint8Array(n)));
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/** 해시끼리 비교해 길이나 내용에 따라 걸리는 시간이 달라지지 않게 합니다. */
export async function sameSecret(expected, given) {
  if (!expected || !given) return false;
  const [a, b] = await Promise.all([sha256Hex(expected), sha256Hex(given)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return toHex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

async function kvGet(env, key) {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first();
  return row ? JSON.parse(row.value) : null;
}

function kvSet(env, key, value) {
  return env.DB.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value));
}

export async function hasPassword(env) {
  return Boolean(await kvGet(env, "admin_password"));
}

/** 바꾼 비밀번호, 또는 처음 키(PCGUARD_ADMIN_KEY)가 맞는지 확인합니다. */
async function passwordMatches(env, password) {
  if (await sameSecret(env.PCGUARD_ADMIN_KEY, password)) return true;
  const stored = await kvGet(env, "admin_password");
  if (!stored || !password) return false;
  return sameSecret(stored.hash, await pbkdf2(password, stored.salt, stored.iterations));
}

async function newSession(env) {
  const token = randomHex(32);
  const expires = db.now(new Date(Date.now() + SESSION_DAYS * 86400 * 1000));
  await env.DB.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), db.now(), expires).run();
  return { token, expires_at: expires };
}

/**
 * 비밀번호로 로그인합니다. 연속으로 틀리면 잠시 잠그되, 처음 키로는 잠금 중에도 들어올 수 있습니다.
 * 반환: { token, expires_at } | { error: "invalid" | "locked" }
 */
export async function login(env, password) {
  const isMasterKey = await sameSecret(env.PCGUARD_ADMIN_KEY, password);
  const fail = (await kvGet(env, "login_failures")) || { count: 0, locked_until: null };
  if (!isMasterKey && fail.locked_until && fail.locked_until > db.now()) return { error: "locked" };
  if (!isMasterKey && !(await passwordMatches(env, password))) {
    const count = fail.count + 1;
    const lockedUntil = count >= MAX_FAILURES ? db.now(new Date(Date.now() + LOCK_MINUTES * 60 * 1000)) : null;
    await kvSet(env, "login_failures", { count: lockedUntil ? 0 : count, locked_until: lockedUntil }).run();
    return { error: "invalid" };
  }
  if (fail.count || fail.locked_until) await kvSet(env, "login_failures", { count: 0, locked_until: null }).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(db.now()).run();
  return newSession(env);
}

/** X-Admin-Key 헤더 값이 처음 키이거나 유효한 세션 토큰인지 확인합니다. */
export async function isAdmin(env, given) {
  if (!given) return false;
  if (await sameSecret(env.PCGUARD_ADMIN_KEY, given)) return true;
  const row = await env.DB.prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(await sha256Hex(given), db.now()).first();
  return Boolean(row);
}

/** 현재 비밀번호(또는 처음 키)를 확인하고 새 비밀번호로 바꿉니다. 다른 기기의 로그인은 모두 풀립니다. */
export async function changePassword(env, current, next) {
  if (!(await passwordMatches(env, current))) return { error: "invalid" };
  const salt = randomHex(16);
  const hash = await pbkdf2(next, salt, PBKDF2_ITERATIONS);
  await env.DB.batch([
    kvSet(env, "admin_password", { salt, hash, iterations: PBKDF2_ITERATIONS, changed_at: db.now() }),
    env.DB.prepare("DELETE FROM sessions"),
  ]);
  return newSession(env);
}

export async function logout(env, token) {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token || "")).run();
}
