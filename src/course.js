// ============================================================
//  科目の内容（content フォルダ）を読み込む
// ============================================================
//  content/course.json と content/guidebook.md は、デプロイのときに
//  Worker の中に取り込まれます（wrangler.jsonc の rules を参照）。
//  科目を変えるときは、この2つのファイルを差し替えます。
// ============================================================

import COURSE from "../content/course.json";
import GUIDEBOOK from "../content/guidebook.md";

export { COURSE, GUIDEBOOK };

export const CATALOG = COURSE.catalog;

export function chapter(n) {
  return CATALOG.chapters.find((c) => c.num === Number(n));
}

export function sectionOf(id) {
  for (const c of CATALOG.chapters) {
    const s = c.sections.find((x) => x.id === id);
    if (s) return { c, s };
  }
  return null;
}

// ガイドブック本文から、各節が参照している付録と、付録の見出しを取り出す
// （移植元の appendixInfo と同じ考え方）
let APPX = null;
export function appendixInfo() {
  if (APPX) return APPX;
  const refs = {};
  const heads = {};
  let cur = null;
  for (const l of GUIDEBOOK.replace(/\r/g, "").split("\n")) {
    const h = l.match(/^## 付録([A-Z])/);
    if (h) heads[h[1]] = l.trim();
    const m = l.match(/^### (\d+-\d+) /);
    if (m) {
      cur = m[1];
      continue;
    }
    if (/^#{1,3} /.test(l)) {
      cur = null;
      continue;
    }
    if (cur) for (const x of l.matchAll(/付録([A-Z])/g)) (refs[cur] = refs[cur] || new Set()).add(x[1]);
  }
  const out = {};
  for (const k of Object.keys(refs)) out[k] = [...refs[k]].sort();
  return (APPX = { refs: out, heads });
}

// ガイドブック本文から、見出し1つ分（次の同じか上の階層の見出しの手前まで）を取り出す
function cutSection(lines, isStart, depth) {
  const i = lines.findIndex(isStart);
  if (i < 0) return "";
  const end = new RegExp("^#{1," + depth + "} ");
  let j = i + 1;
  while (j < lines.length && !end.test(lines[j])) j++;
  return lines.slice(i, j).join("\n").trim();
}

// 学習フローで読む節と、その節が参照する付録の本文を集める（アプリ生成の材料）
export function guidebookExcerpts(flow, maxChars = 80000) {
  const lines = GUIDEBOOK.replace(/\r/g, "").split("\n");
  const ids = [];
  for (const n of (flow && flow.nodes) || []) {
    if (n && n.type === "read" && typeof n.section === "string" && sectionOf(n.section) && !ids.includes(n.section)) ids.push(n.section);
  }
  const { refs } = appendixInfo();
  const letters = [...new Set(ids.flatMap((id) => refs[id] || []))].sort();
  const parts = [];
  for (const id of ids) {
    const t = cutSection(lines, (l) => l.startsWith("### " + id + " "), 3);
    if (t) parts.push(t);
  }
  for (const a of letters) {
    const t = cutSection(lines, (l) => l.startsWith("## 付録" + a), 2);
    if (t) parts.push(t);
  }
  let out = parts.join("\n\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + "\n\n（長いため、ここで切りました）";
  return out;
}

// 画面に渡す科目の内容（course.json ＋ 付録の対応）
export function courseForClient() {
  return { ...COURSE, appendix: appendixInfo() };
}

// AI（学習フローの設計）に渡すカタログ
export function catalogForLLM() {
  return {
    chapters: CATALOG.chapters.map((c) => ({
      num: c.num,
      title: c.title,
      prereq: c.prereq,
      sections: c.sections,
      pitfalls: c.pitfalls.map((p) => p.title + "：" + p.text),
      questions: c.questions,
    })),
    tools: CATALOG.tools.map(({ id, name, sections, chapter }) => ({ id, name, sections, chapter })),
  };
}
