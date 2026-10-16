// 이상 발생 시 관리자에게 알립니다: 웹 푸시(휴대폰/PC 브라우저)와 선택적 웹훅.
import { all, kvGet } from "./db.js";
import { generateVapidJwk, sendWebPush } from "./webpush.js";

/** VAPID 키는 처음 필요할 때 만들어 DB에 보관합니다. 지우면 기기마다 알림을 다시 켜야 합니다. */
export async function loadVapid(db) {
  const saved = await kvGet(db, "vapid_jwk");
  if (saved) return JSON.parse(saved);
  const jwk = await generateVapidJwk();
  // 동시에 두 요청이 만들었다면 먼저 저장된 키를 씁니다.
  await db.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES ('vapid_jwk', ?)").bind(JSON.stringify(jwk)).run();
  return JSON.parse(await kvGet(db, "vapid_jwk"));
}

async function push(env, title, body, url) {
  const rows = await all(env.DB, "SELECT endpoint, data_json FROM push_subscriptions");
  if (!rows.length) return;
  const jwk = await loadVapid(env.DB);
  const subject = env.PCGUARD_VAPID_SUBJECT || "mailto:admin@audreaming.com";
  const payload = JSON.stringify({ title, body, url });
  await Promise.all(rows.map(async (row) => {
    try {
      const res = await sendWebPush(JSON.parse(row.data_json), payload, { jwk, subject });
      if (res.status === 404 || res.status === 410) { // 구독이 해지된 브라우저는 정리
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(row.endpoint).run();
      } else if (!res.ok) {
        console.error(`web push failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.error("web push failed", err);
    }
  }));
}

async function webhook(env, text) {
  if (!env.PCGUARD_WEBHOOK_URL) return;
  try {
    await fetch(env.PCGUARD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 1900), text }),
    });
  } catch (err) {
    console.error("webhook delivery failed", err);
  }
}

export async function notify(env, title, body, url = "/") {
  console.warn(`ALERT ${title}: ${body}`);
  await Promise.all([push(env, title, body, url), webhook(env, `${title}\n${body}`)]);
}
