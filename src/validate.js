// ============================================================
//  保存するときの検査
// ============================================================
//  Gemini が作ったアプリ（title・description・system_prompt・html）を、
//  保存する前にここで確かめます。不合格の理由を、日本語の配列で返します。
//  （空の配列なら合格）
// ============================================================

export const MAX_HTML_BYTES = 500 * 1024; // 500KB
export const MAX_PROMPT_CHARS = 20000;

const FORBIDDEN = [
  { re: /generativelanguage\.googleapis\.com/i, why: "Gemini の API を直接呼んでいます（generativelanguage.googleapis.com）。AI の呼び出しは /api/run/ だけにしてください。" },
  { re: /api\.openai\.com/i, why: "OpenAI の API を直接呼んでいます（api.openai.com）。AI の呼び出しは /api/run/ だけにしてください。" },
  { re: /AIza[0-9A-Za-z_-]{10,}/, why: "API キーのような文字列（AIza…）が含まれています。キーは HTML に書かないでください。" },
  { re: /src\s*=\s*["']?\s*(https?:)?\/\//i, why: "外部のファイルを読み込んでいます（src=\"http…\"）。1つの HTML で完結させてください。" },
  { re: /<link\b[^>]*\bhref\s*=\s*["']?\s*(https?:)?\/\//i, why: "外部のスタイルシートやフォントを読み込んでいます（<link href=\"http…\">）。" },
  { re: /@import\s+(url\(\s*)?["']?\s*(https?:)?\/\//i, why: "CSS で外部のファイルを読み込んでいます（@import url(http…)）。" },
  { re: /window\.LMS_APP\s*=(?!=)/, why: "window.LMS_APP を HTML の中で定義しています。サーバが差し込むので、定義しないでください。" },
];

export function validateApp(app) {
  const reasons = [];
  if (!app || typeof app !== "object") return ["JSON の形が違います。"];
  const { title, system_prompt, html } = app;

  if (typeof title !== "string" || !title.trim()) reasons.push("title がありません。");
  if (typeof system_prompt !== "string" || !system_prompt.trim()) reasons.push("system_prompt がありません。");
  if (typeof html !== "string" || !html.trim()) {
    reasons.push("html がありません。");
    return reasons;
  }

  if (!html.includes("/api/run/")) reasons.push("AI の呼び出し（/api/run/）が見つかりません。決められた形で AI を呼んでください。");
  if (!html.includes("/api/state/")) reasons.push("状態の保存（/api/state/）が見つかりません。進み具合・会話の履歴・メモを決められた形でサーバに保存し、中断と再開ができるようにしてください。");
  if (!/\bprogress\b/.test(html) || !/\bself\b/.test(html)) reasons.push("進み具合の記録（state.progress と、ステップごとの自己評価 self）が見つかりません。決められた形で state.progress に入れてください。");
  for (const f of FORBIDDEN) if (f.re.test(html)) reasons.push(f.why);

  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) reasons.push("html が 500KB を超えています。もっと小さくしてください。");
  if (typeof system_prompt === "string") {
    if (system_prompt.length > MAX_PROMPT_CHARS) reasons.push("system_prompt が 20,000字を超えています。要約して短くしてください。");
    // システムプロンプトの文章が HTML に書き写されていないか（先頭80字で確かめる）
    const head = system_prompt.trim().slice(0, 80);
    if (head.length >= 80 && html.includes(head)) reasons.push("system_prompt の内容が html に書かれています。システムプロンプトは HTML に入れないでください。");
  }
  return reasons;
}
