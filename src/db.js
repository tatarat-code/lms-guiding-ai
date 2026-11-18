// ============================================================
//  データベース（D1、バインディング名 DB）
// ============================================================
//  テーブルは、Worker が最初のリクエストを受けたときに作ります。
//  （CREATE TABLE IF NOT EXISTS なので、すでにあれば何もしません）
//  これで、マイグレーションの手順が要らなくなります。
// ============================================================

import { nowIso } from "./http.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    goal_json TEXT,
    flow_json TEXT,
    plan_md TEXT,
    current_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_versions (
    app_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    system_prompt TEXT NOT NULL,
    html TEXT NOT NULL,
    instruction TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (app_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    input_chars INTEGER,
    output_chars INTEGER,
    latency_ms INTEGER,
    ok INTEGER NOT NULL,
    input_text TEXT,
    output_text TEXT,
    version INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS usage_daily (
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (day, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    ts TEXT NOT NULL,
    ok INTEGER NOT NULL
  )`,
  // 生成アプリの状態（進み具合・会話の履歴・メモ）。アプリ1つにつき1件。
  // 中断と再開、パソコンとスマートフォンの同期のために、要件定義の表に足したテーブル
  `CREATE TABLE IF NOT EXISTS app_state (
    app_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_login_attempts_ts ON login_attempts (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs (created_at)`,
];

// runs.version（CSV の version 列のため、要件定義の表に足した列）が無い古いテーブルに、列を足す
async function addMissingColumns(env) {
  const { results } = await env.DB.prepare("PRAGMA table_info(runs)").all();
  if (!(results || []).some((c) => c.name === "version")) {
    await env.DB.prepare("ALTER TABLE runs ADD COLUMN version INTEGER").run();
  }
}

// ============================================================
//  アプリと版の読み書き
// ============================================================

const APP_COLUMNS = "id, slug, title, description, current_version, created_at, updated_at";

export async function listApps(env) {
  const { results } = await env.DB.prepare(`SELECT ${APP_COLUMNS} FROM apps ORDER BY updated_at DESC`).all();
  return results || [];
}

export function getApp(env, id) {
  return env.DB.prepare(`SELECT ${APP_COLUMNS}, goal_json, flow_json, plan_md FROM apps WHERE id = ?`).bind(id).first();
}

export function getVersion(env, appId, version) {
  return env.DB.prepare("SELECT version, system_prompt, html, instruction, created_at FROM app_versions WHERE app_id = ? AND version = ?")
    .bind(appId, version)
    .first();
}

// slug から、現在の版を引く
export function getCurrentBySlug(env, slug) {
  return env.DB.prepare(
    `SELECT a.id, a.slug, a.title, a.current_version, v.system_prompt, v.html
     FROM apps a JOIN app_versions v ON v.app_id = a.id AND v.version = a.current_version
     WHERE a.slug = ?`,
  )
    .bind(slug)
    .first();
}

export async function listVersions(env, appId) {
  const { results } = await env.DB.prepare(
    "SELECT version, instruction, created_at FROM app_versions WHERE app_id = ? ORDER BY version DESC",
  )
    .bind(appId)
    .all();
  return results || [];
}

// 英小文字と数字8文字のランダムな slug
function randomSlug() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// 新しいアプリを版1として保存する
export async function createApp(env, { title, description, goal, flow, plan, system_prompt, html }) {
  const id = crypto.randomUUID();
  const now = nowIso();
  for (let i = 0; i < 5; i++) {
    const slug = randomSlug();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO apps (id, slug, title, description, goal_json, flow_json, plan_md, current_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).bind(id, slug, title, description, JSON.stringify(goal), JSON.stringify(flow), plan, now, now),
        env.DB.prepare(
          "INSERT INTO app_versions (app_id, version, system_prompt, html, instruction, created_at) VALUES (?, 1, ?, ?, NULL, ?)",
        ).bind(id, system_prompt, html, now),
      ]);
      return { id, slug, version: 1 };
    } catch (err) {
      if (!/UNIQUE/i.test(String(err && err.message))) throw err; // slug が重なったときだけやり直す
    }
  }
  throw new Error("アプリの保存に失敗しました（slug を決められませんでした）。");
}

// 新しい版を追加し、それを現在の版にする
export async function addVersion(env, app, { system_prompt, html, instruction, title, description }) {
  const version = app.current_version + 1;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO app_versions (app_id, version, system_prompt, html, instruction, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(app.id, version, system_prompt, html, instruction, now),
    env.DB.prepare("UPDATE apps SET current_version = ?, title = ?, description = ?, updated_at = ? WHERE id = ?").bind(
      version,
      title ?? app.title,
      description ?? app.description,
      now,
      app.id,
    ),
  ]);
  return { id: app.id, slug: app.slug, version };
}

export async function deleteApp(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM app_versions WHERE app_id = ?").bind(id),
    env.DB.prepare("DELETE FROM app_state WHERE app_id = ?").bind(id),
    env.DB.prepare("DELETE FROM apps WHERE id = ?").bind(id),
  ]);
}

// ---------- 生成アプリの状態（中断と再開） ----------

export function getAppIdBySlug(env, slug) {
  return env.DB.prepare("SELECT id FROM apps WHERE slug = ?").bind(slug).first();
}

export function getState(env, appId) {
  return env.DB.prepare("SELECT state_json, updated_at FROM app_state WHERE app_id = ?").bind(appId).first();
}

export async function putState(env, appId, stateJson) {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO app_state (app_id, state_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
  )
    .bind(appId, stateJson, now)
    .run();
  return now;
}

export async function clearState(env, appId) {
  await env.DB.prepare("DELETE FROM app_state WHERE app_id = ?").bind(appId).run();
}

// 独立アプリの実行の記録
export async function logRun(env, { appId, version, inputChars, outputChars, latencyMs, ok, inputText, outputText }) {
  await env.DB.prepare(
    `INSERT INTO runs (app_id, version, created_at, input_chars, output_chars, latency_ms, ok, input_text, output_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(appId, version ?? null, nowIso(), inputChars, outputChars, latencyMs, ok ? 1 : 0, inputText ?? null, outputText ?? null)
    .run();
}

// 利用ログ（新しい順）。削除したアプリの記録も残る（題名は空になる）
export async function listRuns(env, limit = 50000) {
  const { results } = await env.DB.prepare(
    `SELECT r.created_at, a.title AS app_title, a.slug AS app_slug, r.version, r.input_chars, r.output_chars,
            r.latency_ms, r.ok, r.input_text, r.output_text
     FROM runs r LEFT JOIN apps a ON a.id = r.app_id
     ORDER BY r.id DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return results || [];
}

// 同じ Worker の中では1回だけ実行する（失敗したら次のリクエストでやり直す）
let ready = null;

export function ensureSchema(env) {
  if (!ready) {
    ready = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)))
      .then(() => addMissingColumns(env))
      .catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}
