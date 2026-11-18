// ============================================================
//  1日の上限（日本時間の0時で区切る）
// ============================================================
//  kind: "generate"（学習フロー・学習計画・アプリの生成・改訂）
//        "run"（独立アプリからの AI 呼び出し）
//  上限は wrangler.jsonc の vars（DAILY_LIMIT_GENERATE / DAILY_LIMIT_RUN）で決めます。
// ============================================================

import { jstDay } from "./http.js";

export const LIMIT_MESSAGE = "今日の上限に達しました。明日（日本時間の0時以降）にもう一度試してください。";

const DEFAULTS = { generate: 30, run: 300 };

export function dailyLimit(env, kind) {
  const raw = kind === "run" ? env.DAILY_LIMIT_RUN : env.DAILY_LIMIT_GENERATE;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULTS[kind];
}

// 上限に達していなければ1回数えて true、達していれば false
export async function useQuota(env, kind) {
  const day = jstDay();
  const row = await env.DB.prepare("SELECT count FROM usage_daily WHERE day = ? AND kind = ?").bind(day, kind).first();
  if ((row?.count || 0) >= dailyLimit(env, kind)) return false;
  await env.DB.prepare(
    "INSERT INTO usage_daily (day, kind, count) VALUES (?, ?, 1) ON CONFLICT (day, kind) DO UPDATE SET count = count + 1",
  )
    .bind(day, kind)
    .run();
  return true;
}

// 今日の使用回数と上限
export async function usageToday(env) {
  const day = jstDay();
  const { results } = await env.DB.prepare("SELECT kind, count FROM usage_daily WHERE day = ?").bind(day).all();
  const count = { generate: 0, run: 0 };
  for (const r of results || []) if (r.kind in count) count[r.kind] = r.count;
  return {
    day,
    generate: { count: count.generate, limit: dailyLimit(env, "generate") },
    run: { count: count.run, limit: dailyLimit(env, "run") },
  };
}
