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
    updated_at TEXT NOT NULL,
    settings_json TEXT,
    code TEXT
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
    version INTEGER,
    step INTEGER,
    verdict TEXT
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
    updated_at TEXT NOT NULL,
    progress_done INTEGER,
    progress_total INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_login_attempts_ts ON login_attempts (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs (created_at)`,
];

// 要件定義の表に、あとから足した列。古いテーブルに無ければ足す
//   runs.version        … CSV の version 列のため
//   runs.step / verdict … 学習分析（どのステップの、確認問題の採点結果か）
//   apps.settings_json  … アプリ設定（文字の大きさ・返事の長さ）
const ADDED_COLUMNS = {
  runs: [["version", "INTEGER"], ["step", "INTEGER"], ["verdict", "TEXT"]],
  apps: [["settings_json", "TEXT"], ["code", "TEXT"]],
  app_state: [["progress_done", "INTEGER"], ["progress_total", "INTEGER"]],
};
//   apps.code                        … コード番号（学習ジャンル＋連番。src/code.js）
//   app_state.progress_done / _total … ライブラリの一覧に出す進み具合（保存のたびに state から写す）
async function addMissingColumns(env) {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const have = new Set((results || []).map((c) => c.name));
    for (const [name, type] of cols) {
      if (!have.has(name)) await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
    }
  }
}

// ============================================================
//  アプリと版の読み書き
// ============================================================

const APP_COLUMNS = "id, slug, title, description, current_version, created_at, updated_at";

// 一覧（進み具合と、最後に使った日時を添える）
export async function listApps(env) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.slug, a.title, a.description, a.current_version, a.created_at, a.updated_at, a.code,
            s.progress_done, s.progress_total,
            (SELECT MAX(r.created_at) FROM runs r WHERE r.app_id = a.id AND r.ok = 1) AS last_run_at
     FROM apps a LEFT JOIN app_state s ON s.app_id = a.id
     ORDER BY a.updated_at DESC`,
  ).all();
  return results || [];
}

// ---------- コード番号 ----------

export async function listCodes(env) {
  const { results } = await env.DB.prepare("SELECT code FROM apps WHERE code IS NOT NULL").all();
  return (results || []).map((r) => r.code);
}

// コード番号がまだ無いアプリ（古い順）
export async function listAppsWithoutCode(env) {
  const { results } = await env.DB.prepare("SELECT id, flow_json FROM apps WHERE code IS NULL ORDER BY created_at").all();
  return results || [];
}

export async function setCode(env, id, code) {
  await env.DB.prepare("UPDATE apps SET code = ? WHERE id = ?").bind(code, id).run();
}

export function getApp(env, id) {
  return env.DB.prepare(`SELECT ${APP_COLUMNS}, goal_json, flow_json, plan_md, settings_json FROM apps WHERE id = ?`).bind(id).first();
}

export function getVersion(env, appId, version) {
  return env.DB.prepare("SELECT version, system_prompt, html, instruction, created_at FROM app_versions WHERE app_id = ? AND version = ?")
    .bind(appId, version)
    .first();
}

// slug から、現在の版を引く
export function getCurrentBySlug(env, slug) {
  return env.DB.prepare(
    `SELECT a.id, a.slug, a.title, a.current_version, a.settings_json, v.system_prompt, v.html
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
export async function createApp(env, { title, description, goal, flow, plan, system_prompt, html, code }) {
  const id = crypto.randomUUID();
  const now = nowIso();
  for (let i = 0; i < 5; i++) {
    const slug = randomSlug();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO apps (id, slug, title, description, goal_json, flow_json, plan_md, current_version, created_at, updated_at, code)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).bind(id, slug, title, description, JSON.stringify(goal), JSON.stringify(flow), plan, now, now, code ?? null),
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

export async function putState(env, appId, stateJson, done = null, total = null) {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO app_state (app_id, state_json, updated_at, progress_done, progress_total) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at,
       progress_done = excluded.progress_done, progress_total = excluded.progress_total`,
  )
    .bind(appId, stateJson, now, done, total)
    .run();
  return now;
}

export async function clearState(env, appId) {
  await env.DB.prepare("DELETE FROM app_state WHERE app_id = ?").bind(appId).run();
}

// ---------- アプリ設定 ----------

export async function saveSettings(env, appId, settings) {
  await env.DB.prepare("UPDATE apps SET settings_json = ? WHERE id = ?").bind(JSON.stringify(settings), appId).run();
}

// 独立アプリの実行の記録
export async function logRun(env, { appId, version, step, verdict, inputChars, outputChars, latencyMs, ok, inputText, outputText }) {
  await env.DB.prepare(
    `INSERT INTO runs (app_id, version, step, verdict, created_at, input_chars, output_chars, latency_ms, ok, input_text, output_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(appId, version ?? null, step ?? null, verdict ?? null, nowIso(), inputChars, outputChars, latencyMs, ok ? 1 : 0, inputText ?? null, outputText ?? null)
    .run();
}

// 学習分析のための、1つのアプリの実行の記録（古い順）
export async function listRunsForApp(env, appId, limit = 5000) {
  const { results } = await env.DB.prepare(
    "SELECT created_at, step, verdict, ok FROM runs WHERE app_id = ? ORDER BY id LIMIT ?",
  )
    .bind(appId, limit)
    .all();
  return results || [];
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
