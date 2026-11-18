// ============================================================
//  ログイン・Cookie・Cloudflare Access との照合
// ============================================================
//  - パスワードは env.APP_PASSWORD（Secret）と比べます。ファイルに書かないこと。
//  - ログインの印は Cookie「lms_session」です。中身は「有効期限.署名」。
//    署名の鍵は APP_PASSWORD から作るので、パスワードを変えると
//    それまでのログインはすべて無効になります。セッション用のテーブルは使いません。
// ============================================================

import { json, error, readJson, nowIso } from "./http.js";

const COOKIE_NAME = "lms_session";
const MAX_AGE = 604800; // 7日（秒）
const FAIL_WINDOW_MS = 15 * 60 * 1000; // 連続失敗を数える期間：15分
const FAIL_LIMIT = 10; // この回数を超えたら 429
const enc = new TextEncoder();

// ---------- Cloudflare Access との照合 ----------

function accessEmail(request) {
  return (request.headers.get("Cf-Access-Authenticated-User-Email") || "").trim();
}

// Access のメールと OWNER_EMAIL が食い違っていれば false（→ 403）
export function accessAllowed(request, env) {
  const email = accessEmail(request);
  const owner = (env.OWNER_EMAIL || "").trim();
  if (!email || !owner) return true; // Access 未設定、または照合先が未設定
  return email.toLowerCase() === owner.toLowerCase();
}

// 使用状況タブに出す照合状態
export function accessStatus(request, env) {
  const email = accessEmail(request);
  if (!email) return { enabled: false, label: "Access 未設定：パスワードのみ" };
  if (!(env.OWNER_EMAIL || "").trim()) {
    return { enabled: true, email, matched: false, label: `Access 有効：${email}（OWNER_EMAIL が未設定のため照合していません）` };
  }
  return { enabled: true, email, matched: true, label: `Access 有効：${email} と一致` };
}

// ---------- 署名付き Cookie ----------

const keyCache = new Map();

// APP_PASSWORD から署名用の鍵を作る（重い計算はしない：SHA-256 を1回だけ）
async function signingKey(password) {
  if (keyCache.has(password)) return keyCache.get(password);
  const raw = await crypto.subtle.digest("SHA-256", enc.encode("lms_session_key:" + password));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  keyCache.clear(); // パスワードが変わったら古い鍵は捨てる
  keyCache.set(password, key);
  return key;
}

function toB64url(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function makeToken(password, exp) {
  const key = await signingKey(password);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(COOKIE_NAME + ":" + exp));
  return exp + "." + toB64url(sig);
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

// ログインしているか（Cookie の署名と期限を確かめる）
export async function isLoggedIn(request, env) {
  if (!env.APP_PASSWORD) return false;
  const m = readCookie(request, COOKIE_NAME).match(/^(\d{1,12})\.([A-Za-z0-9_-]{20,100})$/);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp < Math.floor(Date.now() / 1000)) return false;
  let sig;
  try {
    sig = fromB64url(m[2]);
  } catch {
    return false;
  }
  const key = await signingKey(env.APP_PASSWORD);
  // verify は定数時間で比べる
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(COOKIE_NAME + ":" + exp));
}

// 手元（http://localhost）では Secure を付けない（Safari などが Cookie を保存しないため）
function cookieAttrs(request, maxAge) {
  const url = new URL(request.url);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return `HttpOnly;${local ? "" : " Secure;"} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

// ---------- パスワードの比較 ----------

// 長さの違いも漏らさないよう、両方を SHA-256 にしてから定数時間で比べる
async function samePassword(a, b) {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

// ---------- API ----------

// POST /api/login {password}
export async function handleLogin(request, env) {
  if (!env.APP_PASSWORD) {
    return error("パスワード（APP_PASSWORD）が設定されていません。手元では .dev.vars、公開版では Cloudflare の Secret を確認してください。", 500);
  }

  // 直近15分の失敗が多すぎるときは、比べる前に断る
  const since = new Date(Date.now() - FAIL_WINDOW_MS).toISOString();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ok = 0 AND ts >= ?").bind(since).first();
  if ((row?.n || 0) > FAIL_LIMIT) {
    return error("ログインの失敗が続いたため、しばらく受け付けません。15分ほど待ってから試してください。", 429);
  }

  const body = await readJson(request);
  const password = typeof body?.password === "string" ? body.password.slice(0, 1000) : "";
  const ok = password !== "" && (await samePassword(password, env.APP_PASSWORD));

  // 記録する（1日より古い記録は消す）
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO login_attempts (ts, ok) VALUES (?, ?)").bind(nowIso(), ok ? 1 : 0),
    env.DB.prepare("DELETE FROM login_attempts WHERE ts < ?").bind(dayAgo),
  ]);

  if (!ok) return error("パスワードが違います", 401);

  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const token = await makeToken(env.APP_PASSWORD, exp);
  return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE_NAME}=${token}; ${cookieAttrs(request, MAX_AGE)}` });
}

// POST /api/logout
export function handleLogout(request) {
  return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE_NAME}=; ${cookieAttrs(request, 0)}` });
}
