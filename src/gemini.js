// ============================================================
//  Gemini の呼び出し（REST の generateContent を fetch で呼ぶ）
// ============================================================
//  - APIキーは env.GEMINI_API_KEY から読むだけ。ここにキーを書かないこと。
//  - キーはヘッダー x-goog-api-key で送り、URL には付けない。
//  - temperature などは送らない（新しい Gemini では使われず、エラーになることがある）。
// ============================================================

export class GeminiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// contents: [{ role: "user" | "model", parts: [{ text }] }]
export async function callGemini(env, { model, system, contents, json = false, schema = null, maxOutputTokens = 16384 }) {
  if (!env.GEMINI_API_KEY) {
    throw new GeminiError("APIキー（GEMINI_API_KEY）が設定されていません。手元では .dev.vars、公開版では Cloudflare の Secret を確認してください。", 500);
  }
  const body = { contents, generationConfig: { maxOutputTokens } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (json) body.generationConfig.responseMimeType = "application/json";
  if (schema) body.generationConfig.responseSchema = schema;

  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("Gemini への接続に失敗:", err);
    throw new GeminiError("AI（Gemini）に接続できませんでした。時間をおいて、もう一度試してください。");
  }

  if (!res.ok) {
    // 詳しい内容はログにだけ残し、画面には要点だけを返す
    const detail = await res.text().catch(() => "");
    console.error("Gemini エラー:", res.status, detail.slice(0, 2000));
    const badKey = /API_KEY_INVALID|API key not valid/i.test(detail);
    throw new GeminiError(badKey ? errorMessage(401, model) : errorMessage(res.status, model));
  }

  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  const text = ((cand && cand.content && cand.content.parts) || [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
  if (!text.trim()) {
    const reason = (cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || "";
    throw new GeminiError("AI（Gemini）から答えが返ってきませんでした。" + (reason ? "（" + reason + "）" : "") + "もう一度試してください。");
  }
  if (cand.finishReason === "MAX_TOKENS") {
    console.warn("Gemini の出力が上限で切れました:", model);
  }
  return text;
}

function errorMessage(status, model) {
  if (status === 400) return "AI（Gemini）への依頼が受け付けられませんでした（400）。もう一度試して、続くときは教員に連絡してください。";
  if (status === 401 || status === 403) return "APIキーが正しくないか、使えない状態です（" + status + "）。GEMINI_API_KEY を確認してください。";
  if (status === 404) return "モデル「" + model + "」が見つかりません（404）。wrangler.jsonc のモデル名を確認してください。";
  if (status === 429) return "AI（Gemini）の利用の上限に達しました（429）。時間をおいてから試してください。";
  if (status >= 500) return "AI（Gemini）が混み合っているか、一時的に止まっています（" + status + "）。時間をおいて、もう一度試してください。";
  return "AI（Gemini）からエラーが返りました（" + status + "）。時間をおいて、もう一度試してください。";
}

// ```json … ``` のような囲みを外す
export function stripFence(t) {
  t = String(t || "").trim();
  const m = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  return m ? m[1] : t;
}
