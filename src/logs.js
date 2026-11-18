// ============================================================
//  利用ログの CSV（GET /api/logs.csv）
// ============================================================
//  Excel で文字化けしないよう、UTF-8（BOM付き）・改行 CRLF で出します。
//  日時は日本時間（JST）で書きます。
//  LOG_CONTENT="true" のときだけ、入力文と応答文の列を足します。
// ============================================================

import { listRuns } from "./db.js";
import { jstDay } from "./http.js";

function jstTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || "");
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

// CSV の1マス。Excel が数式として読まないよう、= + - @ で始まる文字は先頭に ' を付ける
function cell(v) {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function handleLogsCsv(env) {
  const withContent = String(env.LOG_CONTENT).toLowerCase() === "true";
  const head = ["created_at", "app_title", "app_slug", "version", "input_chars", "output_chars", "latency_ms", "ok"];
  if (withContent) head.push("input_text", "output_text");

  const rows = await listRuns(env);
  const lines = [head.join(",")];
  for (const r of rows) {
    const vals = [
      jstTime(r.created_at),
      r.app_title ?? "（削除済み）",
      r.app_slug ?? "",
      r.version,
      r.input_chars,
      r.output_chars,
      r.latency_ms,
      r.ok,
    ];
    if (withContent) vals.push(r.input_text, r.output_text);
    lines.push(vals.map(cell).join(","));
  }
  const body = "﻿" + lines.join("\r\n") + "\r\n";
  const name = `lms-logs-${jstDay().replace(/-/g, "")}.csv`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
