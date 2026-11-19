// ============================================================
//  Worker の本体：すべてのアクセスをまずここで受け取る
// ============================================================
//  wrangler.jsonc の assets.run_worker_first を true にしているので、
//  画面のファイル（public フォルダ）を返す前に、必ずこのファイルを通ります。
//
//  1. Cloudflare Access のメールと OWNER_EMAIL を照合する（食い違えば 403）
//  2. ログインなしで通すのは、ログイン画面とそこで使うファイルだけ
//  3. それ以外は、ログインしていなければ
//     画面 → /login へ移動、API → 401 を返す
// ============================================================

import { json, error, redirect } from "./http.js";
import { ensureSchema } from "./db.js";
import { accessAllowed, accessStatus, isLoggedIn, handleLogin, handleLogout } from "./auth.js";
import { COURSE, GUIDEBOOK, courseForClient } from "./course.js";
import { usageToday } from "./limits.js";
import { handleFlow, handlePlan } from "./guiding.js";
import { handleGenerate, handleRevise } from "./generate.js";
import { handleList, handleDetail, handleVersions, handleRestore, handleDelete, handleExport } from "./library.js";
import { serveApp, handleRun } from "./run.js";
import { handleLogsCsv } from "./logs.js";
import { handleGetState, handlePutState } from "./state.js";
import { handleSaveSettings } from "./settings.js";
import { handleDashboard } from "./dashboard.js";

// ログインなしで見られる画面のファイル
const PUBLIC_ASSETS = new Set(["/login", "/style.css"]);

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error("処理中のエラー:", err);
      return error("サーバでエラーが起きました。時間をおいて、もう一度試してください。", 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 1. Cloudflare Access との照合
  if (!accessAllowed(request, env)) {
    return new Response("このアプリの持ち主のアカウントではありません（403）。", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!env.DB) {
    return error("データベース（D1 の DB）が設定されていません。wrangler.jsonc を確認してください。", 500);
  }
  await ensureSchema(env);

  // 2. ログインなしで通すもの
  if (path === "/api/login") {
    if (method !== "POST") return error("POST で送ってください。", 405);
    return handleLogin(request, env);
  }
  if (path === "/api/logout") {
    if (method !== "POST") return error("POST で送ってください。", 405);
    return handleLogout(request);
  }

  const loggedIn = await isLoggedIn(request, env);

  if (path === "/login") {
    if (loggedIn) return redirect("/");
    return env.ASSETS.fetch(request);
  }
  if (PUBLIC_ASSETS.has(path)) {
    return env.ASSETS.fetch(request);
  }

  // 3. ここから先はログインが必要
  if (!loggedIn) {
    if (path.startsWith("/api/")) return error("ログインが必要です。", 401);
    return redirect("/login");
  }

  if (path.startsWith("/api/")) {
    return routeApi(request, env, path, method);
  }

  // 独立アプリ
  const appMatch = path.match(/^\/a\/([^/]+)\/?$/);
  if (appMatch && method === "GET") {
    return serveApp(env, appMatch[1]);
  }

  // LMS 画面のファイル
  return env.ASSETS.fetch(request);
}

async function routeApi(request, env, path, method) {
  if (path === "/api/me" && method === "GET") {
    return json({
      loggedIn: true,
      access: accessStatus(request, env),
      usage: await usageToday(env),
      logContent: String(env.LOG_CONTENT).toLowerCase() === "true",
    });
  }

  // 利用ログ
  if (path === "/api/logs.csv" && method === "GET") {
    return handleLogsCsv(env);
  }

  // 科目の内容（ステージ1の選択肢など）
  if (path === "/api/course" && method === "GET") {
    return json(courseForClient());
  }

  // ガイドブック本文のダウンロード
  if (path === "/api/guidebook" && method === "GET") {
    const name = COURSE.course.guidebook_filename || "guidebook.md";
    return new Response(GUIDEBOOK, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="guidebook.md"; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  }

  // ステージ2・4
  if (path === "/api/flow") {
    if (method !== "POST") return error("POST で送ってください。", 405);
    return handleFlow(request, env);
  }
  if (path === "/api/plan") {
    if (method !== "POST") return error("POST で送ってください。", 405);
    return handlePlan(request, env);
  }

  // アプリの生成
  if (path === "/api/generate") {
    if (method !== "POST") return error("POST で送ってください。", 405);
    return handleGenerate(request, env);
  }

  // ライブラリ
  if (path === "/api/apps" && method === "GET") return handleList(env);
  const m = path.match(/^\/api\/apps\/([0-9a-f-]{36})(\/(versions|revise|restore|export|settings|dashboard))?$/);
  if (m) {
    const id = m[1];
    const sub = m[3] || "";
    if (sub === "" && method === "GET") return handleDetail(env, id);
    if (sub === "" && method === "DELETE") return handleDelete(env, id);
    if (sub === "versions" && method === "GET") return handleVersions(env, id);
    if (sub === "export" && method === "GET") return handleExport(env, id);
    if (sub === "revise" && method === "POST") return handleRevise(request, env, id);
    if (sub === "restore" && method === "POST") return handleRestore(request, env, id);
    if (sub === "settings" && method === "POST") return handleSaveSettings(request, env, id);
    if (sub === "dashboard" && method === "GET") return handleDashboard(env, id);
    return error("この方法では使えません。", 405);
  }

  // 独立アプリからの AI 呼び出し
  const run = path.match(/^\/api\/run\/([^/]+)$/);
  if (run) {
    if (method !== "POST") return error("POST で送ってください。", 405);
    return handleRun(request, env, run[1]);
  }

  // 独立アプリの状態の保存（中断と再開）
  const st = path.match(/^\/api\/state\/([^/]+)$/);
  if (st) {
    if (method === "GET") return handleGetState(env, st[1]);
    if (method === "POST" || method === "PUT") return handlePutState(request, env, st[1]);
    return error("この方法では使えません。", 405);
  }

  return error("このアドレスは使われていません。", 404);
}
