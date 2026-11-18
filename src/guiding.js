// ============================================================
//  ガイディング（ステージ2・4）の AI 呼び出し
// ============================================================
//  POST /api/flow {goal}              → 学習フロー（flow.json）
//  POST /api/plan {goal, flow, steps} → 学習計画（plan.md）
//  どちらも1日の上限（generate）に1回ずつ数えます。
// ============================================================

import { json, error, jstDay } from "./http.js";
import { COURSE, CATALOG, sectionOf, catalogForLLM } from "./course.js";
import { callGemini, GeminiError, stripFence } from "./gemini.js";
import { useQuota, LIMIT_MESSAGE } from "./limits.js";
import { flowSystemPrompt } from "./prompts/flow.js";
import { planSystemPrompt } from "./prompts/plan.js";

const MAX_BODY_CHARS = 200000;

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

// 学習フローの形を確かめ、所要時間と合計を整える（移植元の validateFlow と同じ）
function validateFlow(f) {
  if (!f || !Array.isArray(f.nodes) || !Array.isArray(f.edges)) throw new Error("JSONの形が違います。");
  const ids = new Set(f.nodes.map((n) => n.id));
  if (!f.nodes.some((n) => n.type === "start") || !f.nodes.some((n) => n.type === "goal")) throw new Error("start か goal がありません。");
  for (const e of f.edges) if (!ids.has(e.from) || !ids.has(e.to)) throw new Error("存在しないノードへの矢印があります: " + e.from + "→" + e.to);
  for (const n of f.nodes) {
    if (n.type === "read" && n.section && !sectionOf(n.section)) n.title = n.title + "（節番号 " + n.section + " はカタログにありません）";
    if (!n.minutes && n.type === "read" && n.section && sectionOf(n.section)) n.minutes = sectionOf(n.section).s.minutes;
  }
  f.summary = isObject(f.summary) ? f.summary : {};
  f.summary.total_minutes = f.nodes.reduce((a, n) => a + (Number(n.minutes) || 0), 0);
  f.summary.steps = f.nodes.filter((n) => n.type !== "start" && n.type !== "goal").length;
  return f;
}

export async function handleFlow(request, env) {
  const body = await readBody(request);
  if (!isObject(body?.goal) || !isObject(body.goal.chapters)) return error("学習目標（goal）が読み取れませんでした。ステージ1からやり直してください。", 400);
  if (!(await useQuota(env, "generate"))) return error(LIMIT_MESSAGE, 429);

  const user = "## goal\n" + JSON.stringify(body.goal, null, 1) + "\n\n## catalog\n" + JSON.stringify(catalogForLLM());
  try {
    const text = await callGemini(env, {
      model: env.GEMINI_MODEL_BUILD,
      system: flowSystemPrompt(COURSE),
      contents: [{ role: "user", parts: [{ text: user }] }],
      json: true,
    });
    let flow;
    try {
      flow = validateFlow(JSON.parse(stripFence(text)));
    } catch (e) {
      return error("AIの答えを学習フローとして読み取れませんでした（" + e.message + "）。もう一度押してください。", 502);
    }
    return json({ flow });
  } catch (e) {
    if (e instanceof GeminiError) return error(e.message, e.status);
    throw e;
  }
}

export async function handlePlan(request, env) {
  const body = await readBody(request);
  if (!isObject(body?.goal) || !isObject(body?.flow) || !Array.isArray(body?.steps)) {
    return error("学習目標と学習フローが読み取れませんでした。ステージ2からやり直してください。", 400);
  }
  if (!(await useQuota(env, "generate"))) return error(LIMIT_MESSAGE, 429);

  const user =
    "今日の日付：" + jstDay() +
    "\n\n## goal\n" + JSON.stringify(body.goal, null, 1) +
    "\n\n## flow\n" + JSON.stringify(body.flow, null, 1) +
    "\n\n## steps（3. 学習ステップ と 7. 進捗の記録 は、この区切り・番号・タイトルで書く）\n" + JSON.stringify(body.steps, null, 1) +
    "\n\n## 参考：節のタイトル\n" + CATALOG.chapters.map((c) => c.sections.map((s) => s.id + " " + s.title).join("、")).join("\n");
  try {
    const text = await callGemini(env, {
      model: env.GEMINI_MODEL_BUILD,
      system: planSystemPrompt(COURSE),
      contents: [{ role: "user", parts: [{ text: user }] }],
    });
    return json({ plan: stripFence(text) });
  } catch (e) {
    if (e instanceof GeminiError) return error(e.message, e.status);
    throw e;
  }
}
