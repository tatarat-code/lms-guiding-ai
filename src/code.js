// ============================================================
//  コード番号（学習ジャンル＋連番）
// ============================================================
//  例：II-003 …… 第II部（問題を定義する）を中心に学ぶアプリの、3番目
//
//  - 学習ジャンルは、学習フローで読む節が、ガイドブックのどの「部」に多いかで決めます
//    （読む時間の合計がいちばん長い部。同じなら前の部）。
//  - 部の記号（I・II・…）は、content/course.json の parts の key です。
//  - 連番は、同じ部の中での通し番号です。アプリを削除しても、番号は詰めません。
// ============================================================

import { COURSE, sectionOf } from "./course.js";
import { listCodes, listAppsWithoutCode, setCode } from "./db.js";

const OTHER = "X"; // どの部にも当てはまらないとき

// 学習フローから、中心になる部の記号を決める
export function genreKey(flow) {
  const minutes = new Map();
  for (const n of (flow && Array.isArray(flow.nodes) ? flow.nodes : [])) {
    if (!n || n.type !== "read" || typeof n.section !== "string") continue;
    const so = sectionOf(n.section);
    if (!so) continue;
    const part = (COURSE.parts || []).find((p) => p.chapters.includes(so.c.num));
    if (!part) continue;
    minutes.set(part.key, (minutes.get(part.key) || 0) + (Number(n.minutes) || so.s.minutes || 1));
  }
  let best = OTHER;
  let max = 0;
  for (const p of COURSE.parts || []) {
    const m = minutes.get(p.key) || 0;
    if (m > max) {
      max = m;
      best = p.key;
    }
  }
  return best;
}

function format(key, seq) {
  return key + "-" + String(seq).padStart(3, "0");
}

// すでにある番号（codes）を見て、その部の次の番号を作る
function nextIn(codes, key) {
  let max = 0;
  for (const c of codes) {
    const i = c.lastIndexOf("-");
    if (i > 0 && c.slice(0, i) === key) max = Math.max(max, Number(c.slice(i + 1)) || 0);
  }
  return format(key, max + 1);
}

// 新しく作るアプリの番号
export async function nextCode(env, flow) {
  return nextIn(await listCodes(env), genreKey(flow));
}

// 番号が無いアプリ（この仕組みができる前に作ったもの）に、作った順に番号を付ける
export async function fillMissingCodes(env) {
  const rows = await listAppsWithoutCode(env);
  if (!rows.length) return;
  const codes = await listCodes(env);
  for (const r of rows) {
    let flow = null;
    try {
      flow = JSON.parse(r.flow_json);
    } catch {}
    const code = nextIn(codes, genreKey(flow));
    await setCode(env, r.id, code);
    codes.push(code);
  }
}
