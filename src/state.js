// ============================================================
//  生成アプリの状態の保存（中断と再開）
// ============================================================
//  GET  /api/state/<slug>          保存してある状態を返す → { state, updated_at }（無ければ state は null）
//  POST /api/state/<slug> {state}  状態を保存する          → { ok, updated_at }
//                                  state を null にすると消す（最初からやり直すとき）
//
//  - 状態はサーバ（D1）に置くので、パソコンで中断してスマートフォンで再開できます。
//  - 中身は生成アプリが決める JSON です（進み具合・会話の履歴・メモなど）。サーバは中身を見ません。
//  - あとから保存したほうが残ります（2台で同時に書くと、片方の分が消えることがあります）。
//  - 1日の上限には数えません。
// ============================================================

import { json, error } from "./http.js";
import { getAppIdBySlug, getState, putState, clearState } from "./db.js";
import { SLUG_RE } from "./run.js";
import { normalizeProgress } from "./dashboard.js";

const MAX_STATE_BYTES = 200 * 1024; // 200KB

async function findApp(env, slug) {
  if (!SLUG_RE.test(slug)) return null;
  return getAppIdBySlug(env, slug);
}

export async function handleGetState(env, slug) {
  const app = await findApp(env, slug);
  if (!app) return error("このアプリは見つかりません。", 404);
  const row = await getState(env, app.id);
  if (!row) return json({ state: null, updated_at: null });
  let state = null;
  try {
    state = JSON.parse(row.state_json);
  } catch {
    state = null;
  }
  return json({ state, updated_at: row.updated_at }, 200, { "Cache-Control": "no-store" });
}

export async function handlePutState(request, env, slug) {
  const app = await findApp(env, slug);
  if (!app) return error("このアプリは見つかりません。", 404);

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_STATE_BYTES + 100) {
    return error("保存する内容が大きすぎます（200KB まで）。古い会話の履歴を減らしてください。", 413);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return error("送られてきた内容を読み取れませんでした。", 400);
  }
  if (!body || typeof body !== "object" || !("state" in body)) return error("state がありません。", 400);

  if (body.state === null) {
    await clearState(env, app.id);
    return json({ ok: true, updated_at: null });
  }
  if (typeof body.state !== "object") return error("state は JSON のオブジェクトにしてください。", 400);
  const stateJson = JSON.stringify(body.state);
  if (new TextEncoder().encode(stateJson).byteLength > MAX_STATE_BYTES) {
    return error("保存する内容が大きすぎます（200KB まで）。古い会話の履歴を減らしてください。", 413);
  }
  // ライブラリの一覧に出す進み具合（完了したステップ数 / ステップ数）を、一緒に控えておく
  const prog = normalizeProgress(body.state);
  const done = prog ? prog.steps.filter((s) => s.status === "done").length : null;
  const updated_at = await putState(env, app.id, stateJson, done, prog ? prog.steps.length : null);
  return json({ ok: true, updated_at });
}
