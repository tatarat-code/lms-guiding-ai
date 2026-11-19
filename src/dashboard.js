// ============================================================
//  学習分析ダッシュボードの集計（GET /api/apps/:id/dashboard）
// ============================================================
//  2つの記録から作ります。
//   1. 実行の記録（runs）…… やりとりの回数、学習した日、確認問題の採点結果（AI の判定）
//   2. 保存してある状態（app_state）の progress …… 完了したステップ、自己評価
//
//  AI の判定は目安です（誤ることがあります）。画面でもそう断っています。
//  progress の形は、生成アプリの決まり7（src/prompts/build.js）で決めています。
//  古いアプリで形が違うときは、progress を null で返します。
// ============================================================

import { json, error, jstDay } from "./http.js";
import { getApp, getState, listRunsForApp } from "./db.js";

const SELF = new Set(["known", "unsure", "unknown"]);
const STATUS = new Set(["done", "doing", "todo"]);

// 状態の中の progress を、決まった形にそろえて取り出す
function readProgress(stateJson) {
  try {
    return normalizeProgress(JSON.parse(stateJson));
  } catch {
    return null;
  }
}

export function normalizeProgress(st) {
  const p = st && st.progress;
  if (!p || typeof p !== "object" || !Array.isArray(p.steps)) return null;
  const steps = [];
  for (const s of p.steps.slice(0, 50)) {
    const no = Number(s && s.no);
    if (!Number.isInteger(no) || no < 1) continue;
    steps.push({ no, status: STATUS.has(s.status) ? s.status : "todo", self: SELF.has(s.self) ? s.self : null });
  }
  if (!steps.length) return null;
  const current = Number(p.current);
  return { current: Number.isInteger(current) ? current : null, steps };
}

export async function handleDashboard(env, id) {
  const app = await getApp(env, id);
  if (!app) return error("このアプリは見つかりません。", 404);

  const [runs, stateRow] = await Promise.all([listRunsForApp(env, id), getState(env, id)]);

  // 利用の記録
  const days = new Set();
  let count = 0;
  let lastAt = null;
  // ステップごとの、確認問題の採点（AI の判定）
  const byStep = new Map();
  for (const r of runs) {
    if (!r.ok) continue;
    count++;
    lastAt = r.created_at;
    days.add(jstDay(new Date(r.created_at)));
    if (!Number.isInteger(r.step)) continue;
    let s = byStep.get(r.step);
    if (!s) byStep.set(r.step, (s = { step: r.step, messages: 0, graded: 0, passed: false, attempts_to_pass: null }));
    s.messages++;
    if (r.verdict === "pass" || r.verdict === "retry") {
      s.graded++;
      if (r.verdict === "pass" && !s.passed) {
        s.passed = true;
        s.attempts_to_pass = s.graded; // 何回目の採点で合格したか
      }
    }
  }

  return json(
    {
      usage: { runs: count, days: days.size, last_at: lastAt },
      checks: [...byStep.values()].sort((a, b) => a.step - b.step),
      progress: stateRow ? readProgress(stateRow.state_json) : null,
      state_updated_at: stateRow ? stateRow.updated_at : null,
    },
    200,
    { "Cache-Control": "no-store" },
  );
}
