// ============================================================
//  アプリ設定（文字の大きさ・返事の長さ）
// ============================================================
//  POST /api/apps/:id/settings {font, length}
//
//  - 設定は D1 に保存するので、パソコンとスマートフォンで共通です。
//  - 文字の大きさ：アプリを配信するとき（src/run.js）、サーバが拡大率を差し込みます。
//  - 返事の長さ  ：AI を呼ぶとき（src/run.js）、サーバが指示書の末尾に長さの指定を足します。
//  - どちらも選択式です（自由記述にしないので、指示書の方針は設定では変わりません）。
// ============================================================

import { json, error, readJson } from "./http.js";
import { getApp, saveSettings } from "./db.js";

// 文字の大きさ → 拡大率
export const FONT_SCALES = { small: 0.9, normal: 1, large: 1.15, xlarge: 1.3 };

// 返事の長さ → 指示書の末尾に足す文（normal は何も足さない＝アプリの指示書どおり）
export const LENGTH_RULES = {
  short: "1回の返事は150字くらいまでに短くまとめる。",
  normal: "",
  long: "1回の返事は600字くらいまで使ってよい。理由や、ガイドブックのどこに書いてあるかを、ていねいに添える。",
};

export const DEFAULT_SETTINGS = { font: "normal", length: "normal" };

// 保存してある設定を読む（壊れていたり、知らない値なら既定値にする）
export function parseSettings(text) {
  let s = {};
  try {
    s = text ? JSON.parse(text) : {};
  } catch {
    s = {};
  }
  return {
    font: s && s.font in FONT_SCALES ? s.font : DEFAULT_SETTINGS.font,
    length: s && s.length in LENGTH_RULES ? s.length : DEFAULT_SETTINGS.length,
  };
}

export async function handleSaveSettings(request, env, id) {
  const body = await readJson(request);
  if (!body || !(body.font in FONT_SCALES) || !(body.length in LENGTH_RULES)) {
    return error("設定の値が正しくありません。", 400);
  }
  const app = await getApp(env, id);
  if (!app) return error("このアプリは見つかりません。", 404);
  const settings = { font: body.font, length: body.length };
  await saveSettings(env, id, settings);
  return json({ ok: true, settings });
}
