// ============================================================
//  ライブラリ（保存したアプリの一覧・詳細・版の履歴・戻す・削除・書き出し）
// ============================================================

import { json, error, readJson } from "./http.js";
import { parseSettings } from "./settings.js";
import { fillMissingCodes } from "./code.js";
import { listApps, getApp, getVersion, listVersions, addVersion, deleteApp } from "./db.js";

// GET /api/apps
export async function handleList(env) {
  await fillMissingCodes(env); // コード番号ができる前に作ったアプリに、番号を付ける
  return json({ apps: await listApps(env) });
}

// GET /api/apps/:id（現在の版の system_prompt と html を含む）
export async function handleDetail(env, id) {
  const app = await getApp(env, id);
  if (!app) return error("このアプリは見つかりません。", 404);
  const cur = await getVersion(env, id, app.current_version);
  const { goal_json, flow_json, plan_md, settings_json, ...rest } = app;
  return json({
    app: {
      ...rest,
      goal: safeParse(goal_json),
      flow: safeParse(flow_json),
      plan: plan_md,
      settings: parseSettings(settings_json),
      system_prompt: cur ? cur.system_prompt : "",
      html: cur ? cur.html : "",
    },
  });
}

// GET /api/apps/:id/versions（html は含めない）
export async function handleVersions(env, id) {
  const app = await getApp(env, id);
  if (!app) return error("このアプリは見つかりません。", 404);
  return json({ current_version: app.current_version, versions: await listVersions(env, id) });
}

// POST /api/apps/:id/restore {version}（その版の内容で新しい版を作る。履歴は消さない）
export async function handleRestore(request, env, id) {
  const body = await readJson(request);
  const version = Number(body?.version);
  if (!Number.isInteger(version) || version < 1) return error("戻す版の番号が正しくありません。", 400);
  const app = await getApp(env, id);
  if (!app) return error("このアプリは見つかりません。", 404);
  const v = await getVersion(env, id, version);
  if (!v) return error(`版${version}は見つかりません。`, 404);
  // 版ごとの名前は保存していないので、戻した版の HTML の <title> を名前に使う（無ければ今の名前のまま）
  const saved = await addVersion(env, app, {
    system_prompt: v.system_prompt,
    html: v.html,
    instruction: `版${version}に戻す`,
    title: htmlTitle(v.html) || app.title,
  });
  return json({ app: saved });
}

// DELETE /api/apps/:id
export async function handleDelete(env, id) {
  const app = await getApp(env, id);
  if (!app) return error("このアプリは見つかりません。", 404);
  await deleteApp(env, id);
  return json({ ok: true });
}

// GET /api/apps/:id/export（現在の版の HTML。キーもシステムプロンプトも含まない）
export async function handleExport(env, id) {
  const app = await getApp(env, id);
  if (!app) return error("このアプリは見つかりません。", 404);
  const cur = await getVersion(env, id, app.current_version);
  if (!cur) return error("現在の版が見つかりません。", 404);
  const name = `${app.slug}-v${app.current_version}.html`;
  return new Response(cur.html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function htmlTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  if (!m) return "";
  return m[1]
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .trim()
    .slice(0, 100);
}

function safeParse(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
