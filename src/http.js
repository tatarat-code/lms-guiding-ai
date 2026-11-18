// ============================================================
//  応答を作るための小さな道具
// ============================================================

// JSON で返す
export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

// エラーを JSON で返す（画面にはこの文をそのまま表示します）
export function error(message, status) {
  return json({ error: message }, status);
}

// 別のページへ移動させる
export function redirect(location, status = 302) {
  return new Response(null, { status, headers: { Location: location } });
}

// 送られてきた JSON を読む（読めなければ null）
export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// 日本時間（JST）の日付 YYYY-MM-DD
export function jstDay(date = new Date()) {
  return new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 記録用の日時（ISO 形式、UTC）
export function nowIso() {
  return new Date().toISOString();
}
