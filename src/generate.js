// ============================================================
//  アプリの生成・改訂の流れ
// ============================================================
//  POST /api/generate               ステージ1〜4の結果と追加要望から、新しいアプリ（版1）を作る
//  POST /api/apps/:id/revise        現在の版と指示から、新しい版を作る
//
//  1. 1日の上限（generate）を確かめる
//  2. Gemini に { title, description, system_prompt, html } の JSON を作らせる
//  3. src/validate.js で検査する。不合格なら理由を添えて1回だけ作り直させる
//  4. それでも不合格なら保存せずにエラーを返す
// ============================================================

import { json, error } from "./http.js";
import { COURSE, guidebookExcerpts } from "./course.js";
import { callGemini, GeminiError, stripFence } from "./gemini.js";
import { useQuota, LIMIT_MESSAGE } from "./limits.js";
import { validateApp } from "./validate.js";
import { createApp, getApp, getVersion, addVersion } from "./db.js";
import { nextCode } from "./code.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompts/build.js";
import { reviseSystemPrompt, reviseUserPrompt } from "./prompts/revise.js";

const MAX_BODY_CHARS = 400000;
const MAX_REQUEST_CHARS = 2000;

// Gemini に返させる JSON の形
const APP_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    description: { type: "STRING" },
    system_prompt: { type: "STRING" },
    html: { type: "STRING" },
  },
  required: ["title", "description", "system_prompt", "html"],
  propertyOrdering: ["title", "description", "system_prompt", "html"],
};

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isObject = (x) => x && typeof x === "object" && !Array.isArray(x);

function parseApp(text) {
  try {
    const a = JSON.parse(stripFence(text));
    if (!isObject(a)) return null;
    return {
      title: String(a.title || "").trim().slice(0, 100),
      description: String(a.description || "").trim().slice(0, 300),
      system_prompt: String(a.system_prompt || ""),
      html: String(a.html || ""),
    };
  } catch {
    return null;
  }
}

// Gemini に作らせて検査する（不合格なら1回だけ作り直させる）
async function produceApp(env, system, user) {
  const contents = [{ role: "user", parts: [{ text: user }] }];
  const ask = () =>
    callGemini(env, { model: env.GEMINI_MODEL_BUILD, system, contents, json: true, schema: APP_SCHEMA, maxOutputTokens: 65536 });

  let text = await ask();
  let app = parseApp(text);
  let reasons = app ? validateApp(app) : ["JSON として読み取れませんでした（途中で切れた可能性があります）。"];
  if (!reasons.length) return { app };

  console.warn("検査に不合格のため、作り直させます:", reasons);
  contents.push(
    { role: "model", parts: [{ text }] },
    {
      role: "user",
      parts: [{ text: "保存前の検査で、次の点が不合格でした。\n- " + reasons.join("\n- ") + "\nこれらを直した、完全な JSON を返してください（title・description・system_prompt・html のすべて）。" }],
    },
  );
  text = await ask();
  app = parseApp(text);
  reasons = app ? validateApp(app) : ["JSON として読み取れませんでした（途中で切れた可能性があります）。"];
  if (reasons.length) {
    console.warn("作り直しても不合格:", reasons);
    return { reasons };
  }
  return { app };
}

function rejected(reasons) {
  return error(
    "検査に合格するアプリを作れなかったため、保存しませんでした。\n理由：" + reasons.join(" ") + "\nもう一度試すか、要望の書き方を変えてみてください。",
    422,
  );
}

function geminiFailure(e) {
  if (e instanceof GeminiError) return error(e.message, e.status);
  throw e;
}

// POST /api/generate {goal, flow, plan, steps, request}
export async function handleGenerate(request, env) {
  const body = await readBody(request);
  if (!isObject(body?.goal) || !isObject(body?.flow) || typeof body?.plan !== "string" || !body.plan.trim() || !Array.isArray(body?.steps)) {
    return error("ステージ1〜4の結果が読み取れませんでした。学習計画まで進めてから試してください。", 400);
  }
  const req = typeof body.request === "string" ? body.request : "";
  if (req.length > MAX_REQUEST_CHARS) return error(`追加の要望は ${MAX_REQUEST_CHARS} 字以内にしてください。`, 400);
  if (!(await useQuota(env, "generate"))) return error(LIMIT_MESSAGE, 429);

  const user = buildUserPrompt({
    goal: body.goal,
    flow: body.flow,
    plan: body.plan,
    steps: body.steps,
    excerpts: guidebookExcerpts(body.flow),
    request: req,
  });
  let result;
  try {
    result = await produceApp(env, buildSystemPrompt(COURSE), user);
  } catch (e) {
    return geminiFailure(e);
  }
  if (result.reasons) return rejected(result.reasons);

  const code = await nextCode(env, body.flow);
  const saved = await createApp(env, { ...result.app, goal: body.goal, flow: body.flow, plan: body.plan, code });
  return json({ app: saved });
}

// POST /api/apps/:id/revise {instruction}
export async function handleRevise(request, env, id) {
  const body = await readBody(request);
  // 指示は空でもよい（空のときは、中身を変えずに最新の決まりに合わせるだけ）
  const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";
  if (instruction.length > MAX_REQUEST_CHARS) return error(`更新の指示は ${MAX_REQUEST_CHARS} 字以内にしてください。`, 400);

  const app = await getApp(env, id);
  if (!app) return error("このアプリは見つかりません。", 404);
  const cur = await getVersion(env, id, app.current_version);
  if (!cur) return error("現在の版が見つかりません。", 404);
  if (!(await useQuota(env, "generate"))) return error(LIMIT_MESSAGE, 429);

  const user = reviseUserPrompt({
    current: { title: app.title, description: app.description, system_prompt: cur.system_prompt, html: cur.html },
    instruction,
  });
  let result;
  try {
    result = await produceApp(env, reviseSystemPrompt(COURSE), user);
  } catch (e) {
    return geminiFailure(e);
  }
  if (result.reasons) return rejected(result.reasons);

  const saved = await addVersion(env, app, { ...result.app, instruction: instruction || "最新の決まりに合わせて更新" });
  return json({ app: saved });
}
