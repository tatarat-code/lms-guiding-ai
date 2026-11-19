// ============================================================
//  独立アプリの配信（GET /a/<slug>）と実行（POST /api/run/<slug>）
// ============================================================

import { json, readJson } from "./http.js";
import { getCurrentBySlug, logRun } from "./db.js";
import { callGemini, GeminiError, stripFence } from "./gemini.js";
import { useQuota, LIMIT_MESSAGE } from "./limits.js";
import { parseSettings, FONT_SCALES, LENGTH_RULES } from "./settings.js";

const MAX_INPUT_CHARS = 4000;
const MAX_HISTORY = 20;
const MAX_HISTORY_TEXT = 8000;

export const SLUG_RE = /^[a-z0-9]{8}$/;

const APP_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'self'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

function notFound() {
  return new Response("このアプリは見つかりません。", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// GET /a/<slug>：現在の版の HTML の <head> 直後に、window.LMS_APP と文字の大きさの設定を差し込んで返す
// 文字の大きさは、html の font-size を拡大率どおりに変える（rem で書かれた文字と余白が、その倍率になる）
export async function serveApp(env, slug) {
  if (!SLUG_RE.test(slug)) return notFound();
  const row = await getCurrentBySlug(env, slug);
  if (!row) return notFound();
  const scale = FONT_SCALES[parseSettings(row.settings_json).font];
  const inject =
    `<script>window.LMS_APP={slug:${JSON.stringify(slug)},settings:{fontScale:${scale}}};</script>` +
    `<style>:root{--lms-font-scale:${scale}}html{font-size:calc(100% * ${scale}) !important}</style>`;
  const html = row.html;
  const m = html.match(/<head(\s[^>]*)?>/i);
  const out = m ? html.slice(0, m.index + m[0].length) + inject + html.slice(m.index + m[0].length) : inject + html;
  return new Response(out, { headers: APP_HEADERS });
}

// 生成アプリは { text } を表示するので、失敗のときも text に日本語の説明を入れて返す
function fail(message, status) {
  return json({ error: message, text: message }, status);
}

// 会話の履歴を Gemini の contents の形にそろえる
function toContents(history, input) {
  const items = [];
  for (const h of history) {
    if (!h || (h.role !== "user" && h.role !== "model") || typeof h.text !== "string") continue;
    const text = h.text.trim().slice(0, MAX_HISTORY_TEXT);
    if (text) items.push({ role: h.role, text });
  }
  items.push({ role: "user", text: input });
  // 同じ役が続いたら1つにまとめ、最初は必ず user にする
  const merged = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (last && last.role === it.role) last.text += "\n\n" + it.text;
    else merged.push({ ...it });
  }
  if (merged[0].role === "model") merged.unshift({ role: "user", text: "（はじめ）" });
  return merged.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
}

// ステップ番号が付いた呼び出しでは、返事と一緒に「確認問題の採点結果」を返させる（学習分析のため）
const CHECK_SCHEMA = {
  type: "OBJECT",
  properties: { text: { type: "STRING" }, check: { type: "STRING", enum: ["pass", "retry", "none"] } },
  required: ["text", "check"],
  propertyOrdering: ["text", "check"],
};
const CHECK_RULE = `

## 返事の形式（サーバからの指定）
JSON で返す。
- text：学習者への返事。これまでの指示どおりの文章を、そのまま入れる。
- check：この返事が、確認問題に対する学習者の答えを採点したものであれば、十分なら "pass"、不十分でもう一度答えてもらうなら "retry"。採点ではない返事（読む節の案内、説明、出題、質問への答え、雑談など）は "none"。`;

function readCheckReply(raw) {
  try {
    const j = JSON.parse(stripFence(raw));
    if (j && typeof j.text === "string" && j.text.trim()) {
      return { text: j.text, check: ["pass", "retry"].includes(j.check) ? j.check : "none" };
    }
  } catch {}
  return { text: raw, check: null }; // JSON で返らなかったときは、文章としてそのまま使う
}

// POST /api/run/<slug> {input, history, step}
export async function handleRun(request, env, slug) {
  if (!SLUG_RE.test(slug)) return fail("このアプリは見つかりません。", 404);
  const app = await getCurrentBySlug(env, slug);
  if (!app) return fail("このアプリは見つかりません。", 404);

  const body = await readJson(request);
  const input = typeof body?.input === "string" ? body.input.trim() : "";
  if (!input) return fail("入力が空です。何か書いてから送ってください。", 400);
  if (input.length > MAX_INPUT_CHARS) return fail(`入力は ${MAX_INPUT_CHARS.toLocaleString()} 字以内にしてください。`, 400);
  const history = Array.isArray(body?.history) ? body.history.slice(-MAX_HISTORY) : [];
  // step（いまのステップの番号）は、新しい決まりで作ったアプリだけが送る
  const step = Number.isInteger(body?.step) && body.step >= 1 && body.step <= 99 ? body.step : null;
  const lengthRule = LENGTH_RULES[parseSettings(app.settings_json).length];
  const system =
    app.system_prompt +
    (lengthRule ? `

## 返事の長さ（学習者の設定。上の長さの指定より優先する）
${lengthRule}` : "") +
    (step ? CHECK_RULE : "");

  if (!(await useQuota(env, "run"))) return fail(LIMIT_MESSAGE, 429);

  const logContent = String(env.LOG_CONTENT).toLowerCase() === "true";
  const t0 = Date.now();
  let text = "";
  let check = null;
  let message = "";
  try {
    const raw = await callGemini(env, {
      model: env.GEMINI_MODEL_RUN,
      system,
      contents: toContents(history, input),
      maxOutputTokens: 8192,
      json: Boolean(step),
      schema: step ? CHECK_SCHEMA : null,
    });
    if (step) ({ text, check } = readCheckReply(raw));
    else text = raw;
  } catch (e) {
    if (!(e instanceof GeminiError)) console.error("実行中のエラー:", e);
    message = e instanceof GeminiError ? e.message : "AI からの返事を受け取れませんでした。少し時間をおいて、もう一度送ってください。";
  }
  const ok = !message;

  await logRun(env, {
    appId: app.id,
    version: app.current_version,
    step,
    verdict: ok ? check : null,
    inputChars: input.length,
    outputChars: ok ? text.length : 0,
    latencyMs: Date.now() - t0,
    ok,
    inputText: logContent ? input : null,
    outputText: logContent && ok ? text : null,
  });

  return ok ? json(step ? { text, check: check || "none" } : { text }) : fail(message, 502);
}
