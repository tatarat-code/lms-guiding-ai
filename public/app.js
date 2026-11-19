// ============================================================
//  LMS 画面の動き
// ============================================================
//  「つくる」タブのステージ1〜4は、reference/guiding-ai_V3.html の
//  スクリプトを移植したものです（見た目・操作は変えていません）。
//  変えたところ：
//   - 科目の内容（カタログ・部・カテゴリ・文言）は /api/course から読む
//   - AI の呼び出し（ステージ2・4）は、ブラウザから Google ではなく /api/flow・/api/plan に送る
//     （APIキーはサーバの Secret にあり、ブラウザには届かない）
//   - ステージ5は「アプリを生成する」に置き換えた
//  ※ APIキーはここに書かない。
// ============================================================
(function () {
"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------------- サーバとのやりとり ---------------- */
async function api(path, body, method) {
  const opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  if (method) opt.method = method;
  let res;
  try { res = await fetch(path, opt); }
  catch (e) { throw new Error("通信に失敗しました。ネットワークを確認して、もう一度試してください。"); }
  if (res.status === 401) { location.href = "/login"; throw new Error("ログインが必要です。"); }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || "エラーが発生しました（" + res.status + "）。");
  return data;
}

/* ---------------- タブ ---------------- */
const TAB_KEY = "lms-tab";
function showTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $$(".tabpanel").forEach((p) => p.classList.toggle("on", p.id === "tab-" + name));
  $("#btnReset").style.display = name === "make" ? "" : "none";
  try { sessionStorage.setItem(TAB_KEY, name); } catch (e) {}
  if (name === "make" && S && S.stage === 1) requestAnimationFrame(drawProfileLine);
  if (name === "library") return loadLibrary();
  if (name === "usage") loadUsage();
  if (name === "app") loadDash();
}

/* 時間のかかる処理の進行表示（経過秒数を出す） */
function progress(el, message) {
  const t0 = Date.now();
  const paint = () => { el.className = "status"; el.innerHTML = '<span class="spin"></span>' + message + "（" + Math.floor((Date.now() - t0) / 1000) + "秒）"; };
  paint(); const timer = setInterval(paint, 1000);
  return () => clearInterval(timer);
}
function fmtTime(iso) {
  const d = new Date(iso); if (isNaN(d)) return String(iso || "");
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "/" + p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
function setErr(el, msg) { el.className = "status err"; el.textContent = msg; }

/* ============================================================
   ライブラリ
   ============================================================ */
let current = null;  // 開いているアプリ
const OPEN_KEY = "lms-open-app";

let libApps = [];  // 一覧（サーバから届いた順＝標準の順：更新が新しい順）
const SORT_KEY = "lms-lib-sort";
let libSort = { key: "default", desc: false };
try { const s = JSON.parse(localStorage.getItem(SORT_KEY) || "null"); if (s && ["default", "title", "created", "code"].includes(s.key)) libSort = { key: s.key, desc: !!s.desc }; } catch (e) {}

function fmtDate(iso) {
  const d = new Date(iso); if (isNaN(d)) return "–";
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "/" + p(d.getMonth() + 1) + "/" + p(d.getDate());
}
// コード番号「II-003」→ 部の記号と連番
function codeParts(code) { const s = String(code || ""), i = s.lastIndexOf("-"); return i > 0 ? { key: s.slice(0, i), seq: Number(s.slice(i + 1)) || 0 } : { key: "", seq: 0 }; }
function partOf(code) { const k = codeParts(code).key; return (PARTS || []).find((p) => p.key === k) || null; }
function partIndex(code) { const k = codeParts(code).key, i = (PARTS || []).findIndex((p) => p.key === k); return i < 0 ? 999 : i; }

function sortedApps() {
  const a = libApps.slice(), k = libSort.key;
  if (k === "title") a.sort((x, y) => x.title.localeCompare(y.title, "ja"));
  else if (k === "created") a.sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0));
  else if (k === "code") a.sort((x, y) => partIndex(x.code) - partIndex(y.code) || codeParts(x.code).seq - codeParts(y.code).seq);
  if (k !== "default" && libSort.desc) a.reverse();
  return a;
}
function renderLibrary() {
  $$("#libSort button").forEach((b) => {
    const on = b.dataset.k === libSort.key;
    b.classList.toggle("on", on);
    b.textContent = b.textContent.replace(/ [▲▼]$/, "") + (on && libSort.key !== "default" ? (libSort.desc ? " ▼" : " ▲") : "");
  });
  $("#libSortNote").textContent = libSort.key === "default" ? "更新が新しい順" : "同じボタンをもう一度押すと、逆順になります";
  const box = $("#libCards"); box.innerHTML = "";
  if (!libApps.length) { box.innerHTML = '<div class="empty">まだアプリがありません。「つくる」タブでステージ5まで進み、「アプリを生成」を押してください。</div>'; return; }
  for (const a of sortedApps()) {
    const part = partOf(a.code);
    const has = Number.isInteger(a.progress_total) && a.progress_total > 0;
    const pct = has ? Math.round(a.progress_done / a.progress_total * 100) : 0;
    const b = document.createElement("button"); b.type = "button"; b.className = "apptile";
    if (part) b.style.setProperty("--pc", part.color);
    b.title = a.description || a.title;
    b.innerHTML = '<span class="code"></span><span class="genre"></span><span class="t"></span>'
      + '<span class="meta">作成日 <b class="cd"></b></span>'
      + '<span class="mini"><span class="pg"></span><span class="meter"><i style="width:' + pct + '%"></i></span><span class="last"></span></span>';
    b.querySelector(".code").textContent = a.code || "–";
    b.querySelector(".genre").textContent = part ? part.name : "";
    b.querySelector(".t").textContent = a.title;
    b.querySelector(".cd").textContent = fmtDate(a.created_at);
    b.querySelector(".pg").textContent = has ? "進捗 " + a.progress_done + " / " + a.progress_total + "（" + pct + "%）" : "進捗 –";
    b.querySelector(".last").textContent = "前回 " + (a.last_run_at ? fmtDate(a.last_run_at) : "まだ");
    b.onclick = () => openApp(a.id);
    box.appendChild(b);
  }
}
$$("#libSort button").forEach((b) => (b.onclick = () => {
  const k = b.dataset.k;
  libSort = { key: k, desc: k !== "default" && libSort.key === k ? !libSort.desc : false };
  try { localStorage.setItem(SORT_KEY, JSON.stringify(libSort)); } catch (e) {}
  renderLibrary();
}));

async function loadLibrary() {
  $("#libStatus").className = "status"; $("#libStatus").textContent = "読み込んでいます…";
  try {
    const { apps } = await api("/api/apps");
    $("#libStatus").textContent = "";
    libApps = apps; renderLibrary();
  } catch (e) { setErr($("#libStatus"), "一覧を読み込めませんでした：" + e.message); }
}

// アプリを開く。上部に「アプリ：〈名前〉」のタブを出す（show が false なら、タブを出すだけで切り替えない）
async function openApp(id, show = true) {
  $("#tabApp").hidden = false;
  if (!current || current.id !== id) { $("#tabAppName").textContent = "…"; $("#detTitle").textContent = "読み込んでいます…"; }
  if (show) showTab("app");
  $("#reviseStatus").textContent = ""; $("#verStatus").textContent = "";
  try { sessionStorage.setItem(OPEN_KEY, id); } catch (e) {}
  try {
    const [{ app }, vs] = await Promise.all([api("/api/apps/" + id), api("/api/apps/" + id + "/versions")]);
    current = app;
    $("#detTitle").textContent = app.title;
    $("#tabAppName").textContent = app.title; $("#tabApp").title = app.title;
    $("#detVer").textContent = "版" + app.current_version;
    $("#detDesc").textContent = app.description || "";
    $("#detOpen").href = "/a/" + app.slug;
    $("#detExport").href = "/api/apps/" + app.id + "/export";
    $("#detFrame").src = "/a/" + app.slug + "?v=" + app.current_version;
    renderVersions(vs);
    paintSettings();
    loadDash();
    if (show) window.scrollTo({ top: 0 });
  } catch (e) {
    const shown = $("#tab-app").classList.contains("on");
    closeApp();
    if (shown) showTab("library").then(() => setErr($("#libStatus"), "アプリを開けませんでした：" + e.message));
  }
}
// アプリを閉じる（タブを消す）
function closeApp() {
  current = null; $("#detFrame").src = "about:blank"; $("#tabApp").hidden = true;
  $("#settingsModal").classList.remove("on");
  try { sessionStorage.removeItem(OPEN_KEY); } catch (e) {}
}

function renderVersions({ current_version, versions }) {
  const ol = $("#detVersions"); ol.innerHTML = "";
  for (const v of versions) {
    const li = document.createElement("li"); if (v.version === current_version) li.className = "cur";
    li.innerHTML = `<div class="vh"><b></b><span class="when"></span><span class="sp"></span></div><div class="ins"></div>`;
    li.querySelector("b").textContent = "版" + v.version + (v.version === current_version ? "（現在）" : "");
    li.querySelector(".when").textContent = fmtTime(v.created_at);
    li.querySelector(".ins").textContent = v.instruction || (v.version === 1 ? "最初に生成した版" : "");
    if (v.version !== current_version) {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn small"; b.textContent = "この版に戻す";
      b.onclick = () => restoreVersion(v.version);
      li.querySelector(".vh").appendChild(b);
    }
    ol.appendChild(li);
  }
}

async function restoreVersion(v) {
  if (!current) return;
  if (!confirm("版" + v + "の内容で、新しい版を作ります（いまの版は履歴に残ります）。よろしいですか？")) return;
  $("#verStatus").className = "status"; $("#verStatus").textContent = "戻しています…";
  try { await api("/api/apps/" + current.id + "/restore", { version: v }); await openApp(current.id); $("#verStatus").textContent = "版" + v + "の内容に戻しました。"; }
  catch (e) { setErr($("#verStatus"), "戻せませんでした：" + e.message); }
}

$("#reviseBtn").onclick = async () => {
  if (!current) return;
  const instruction = $("#reviseText").value.trim();  // 空でもよい（最新の決まりに合わせるだけ）
  $("#reviseBtn").disabled = true; $("#reviseCancel").disabled = true;
  const stop = progress($("#reviseStatus"), "更新しています。30〜90秒かかることがあります。この窓を閉じずにお待ちください");
  try {
    await api("/api/apps/" + current.id + "/revise", { instruction });
    stop(); $("#reviseText").value = "";
    await openApp(current.id);
    $("#reviseStatus").className = "status"; $("#reviseStatus").textContent = "更新して、新しい版を保存しました。";
  } catch (e) { stop(); setErr($("#reviseStatus"), "更新できませんでした：" + e.message); }
  finally { $("#reviseBtn").disabled = false; $("#reviseCancel").disabled = false; }
};
// 更新しない：書きかけの指示を消して、設定の窓を閉じる
$("#reviseCancel").onclick = () => { $("#reviseText").value = ""; $("#reviseStatus").textContent = ""; $("#setAdvanced").open = false; $("#settingsModal").classList.remove("on"); };

/* ---------------- アプリ設定 ---------------- */
function paintSettings() {
  if (!current) return;
  const s = current.settings || { font: "normal", length: "normal" };
  $$("#setFont button").forEach((b) => b.classList.toggle("on", b.dataset.v === s.font));
  $$("#setLength button").forEach((b) => b.classList.toggle("on", b.dataset.v === s.length));
}
async function saveSetting(key, value) {
  if (!current) return;
  const next = Object.assign({ font: "normal", length: "normal" }, current.settings, { [key]: value });
  $("#setStatus").className = "status"; $("#setStatus").textContent = "保存しています…";
  try {
    const { settings } = await api("/api/apps/" + current.id + "/settings", next);
    current.settings = settings; paintSettings();
    $("#setStatus").textContent = "保存しました。";
    // 文字の大きさは、プレビューを読み込み直して反映する（返事の長さは、次の返事から変わる）
    if (key === "font") $("#detFrame").src = "/a/" + current.slug + "?v=" + current.current_version + "&f=" + settings.font;
  } catch (e) { setErr($("#setStatus"), "保存できませんでした：" + e.message); }
}
$$("#setFont button").forEach((b) => (b.onclick = () => saveSetting("font", b.dataset.v)));
$$("#setLength button").forEach((b) => (b.onclick = () => saveSetting("length", b.dataset.v)));
$("#detSettings").onclick = () => { if (!current) return; paintSettings(); $("#setStatus").textContent = ""; $("#settingsModal").classList.add("on"); };
$("#setClose").onclick = () => $("#settingsModal").classList.remove("on");
$("#settingsModal").addEventListener("click", (e) => { if (e.target === $("#settingsModal") && !$("#reviseBtn").disabled) $("#settingsModal").classList.remove("on"); });

/* ---------------- 学習分析ダッシュボード ---------------- */
const SELF_NAME = { known: "分かった", unsure: "あいまい", unknown: "分からない" };
function selfDot(v) { return v ? '<i class="dot ' + v + '" title="' + SELF_NAME[v] + '"></i>' + SELF_NAME[v] : '<span class="na">–</span>'; }
function checkLabel(c, kind) {
  if (kind === "apply") return { cls: "na", text: "確認問題なし（自分で考える）" };
  if (!c || !c.graded) return { cls: "na", text: "確認問題：まだ" };
  if (c.passed) return c.attempts_to_pass === 1 ? { cls: "good", text: "確認問題：1回で合格" } : { cls: "mid", text: "確認問題：" + c.attempts_to_pass + "回目で合格" };
  return { cls: "low", text: "確認問題：挑戦中（" + c.graded + "回）" };
}
async function loadDash() {
  if (!current) return;
  const id = current.id;
  let d;
  try { d = await api("/api/apps/" + id + "/dashboard"); }
  catch (e) { setErr($("#dashStatus"), "学習の記録を取得できませんでした：" + e.message); return; }
  if (!current || current.id !== id) return;
  $("#dashStatus").textContent = "";

  let steps = [];
  try { steps = deriveSteps(current.flow); } catch (e) {}
  const prog = d.progress, byNo = {}, checks = {};
  if (prog) prog.steps.forEach((s) => (byNo[s.no] = s));
  d.checks.forEach((c) => (checks[c.step] = c));
  const total = steps.length || (prog ? prog.steps.length : 0);

  // 進み具合
  if (prog) {
    const done = prog.steps.filter((s) => s.status === "done").length;
    $("#dashDone").textContent = done + " / " + total;
    $("#dashDoneNote").textContent = "ステップ完了";
    $("#dashBar").style.width = (total ? Math.round(done / total * 100) : 0) + "%";
    const cur = steps.find((s) => s.no === prog.current);
    $("#dashNow").textContent = done >= total && total ? "すべてのステップを完了しました。" : prog.current ? "いま：ステップ" + prog.current + (cur ? "　" + cur.title : "") : "";
  } else {
    $("#dashDone").textContent = "–"; $("#dashDoneNote").textContent = ""; $("#dashBar").style.width = "0%";
    $("#dashNow").textContent = d.usage.runs
      ? "このアプリは、進み具合を記録する形になっていません。「アプリ設定」→「詳細」→「更新する」で対応します。"
      : "まだ学習を始めていません。左のアプリで学習を始めると、ここに記録が出ます。";
  }

  // ステップごと
  const ol = $("#dashSteps"); ol.innerHTML = "";
  const rows = steps.length ? steps : (prog ? prog.steps.map((s) => ({ no: s.no, title: "ステップ" + s.no, kind: "read" })) : []);
  for (const s of rows) {
    const p = byNo[s.no] || { status: "todo", self: null };
    const before = s.kind === "read" && s.sections && s.sections[0] && current.goal && current.goal.chapters ? current.goal.chapters[chapterNumOf(s.sections[0].id)] : null;
    const ck = checkLabel(checks[s.no], s.kind);
    const stName = { done: "完了", doing: "学習中", todo: "まだ" }[p.status];
    const li = document.createElement("li"); li.className = "st-" + p.status;
    li.innerHTML = '<div class="sh"><span class="no"></span><span class="tt"></span><span class="badge ' + p.status + '">' + stName + "</span></div>"
      + (s.kind === "apply" ? "" : '<div class="sr"><span>学習前 ' + selfDot(before) + '</span><span class="arrow">→</span><span>学習後 ' + selfDot(p.self) + "</span></div>")
      + '<div class="sr"><span class="ck ' + ck.cls + '">' + ck.text + "</span></div>";
    li.querySelector(".no").textContent = s.no;
    li.querySelector(".tt").textContent = s.title;
    ol.appendChild(li);
  }
  if (!rows.length) ol.innerHTML = '<li class="na">ステップの記録はまだありません。</li>';

  // 利用の記録
  const u = d.usage;
  $("#dashUsage").innerHTML = '<div><b>' + u.runs + '</b><span>やりとり（回）</span></div><div><b>' + u.days + '</b><span>学習した日数</span></div><div><b class="sm"></b><span>最後に使った日時</span></div>';
  $("#dashUsage .sm").textContent = u.last_at ? fmtTime(u.last_at) : "–";
}
$("#dashReload").onclick = loadDash;
// アプリのタブを開いている間は、30秒ごとに最新にする
setInterval(() => { if (current && $("#tab-app").classList.contains("on") && !document.hidden) loadDash(); }, 30000);

$("#detDelete").onclick = async () => {
  if (!current) return;
  if (!confirm("「" + current.title + "」を削除します。すべての版も消え、元に戻せません。よろしいですか？")) return;
  try { await api("/api/apps/" + current.id, undefined, "DELETE"); closeApp(); showTab("library"); }
  catch (e) { alert("削除できませんでした：" + e.message); }
};
$("#libBack").onclick = () => showTab("library");
$("#appClose").onclick = () => { closeApp(); showTab("library"); };
$$(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

/* ---------------- ログアウト ---------------- */
$("#btnLogout").onclick = async () => {
  try { await fetch("/api/logout", { method: "POST" }); } catch (e) {}
  location.href = "/login";
};

/* ============================================================
   使用状況
   ============================================================ */
function paintUsage(b, bar, u) {
  const over = u.count >= u.limit;
  b.textContent = u.count + " / " + u.limit + " 回";
  b.classList.toggle("over", over);
  bar.style.width = (u.limit > 0 ? Math.min(100, Math.round(u.count / u.limit * 100)) : 100) + "%";
  bar.classList.toggle("over", over);
}
async function loadUsage() {
  $("#usageStatus").className = "status"; $("#usageStatus").textContent = "";
  try {
    const me = await api("/api/me");
    $("#usageDay").textContent = me.usage.day;
    paintUsage($("#useGen"), $("#useGenBar"), me.usage.generate);
    paintUsage($("#useRun"), $("#useRunBar"), me.usage.run);
    $("#accessLabel").textContent = me.access.label;
    $("#logNote").textContent = "アプリが AI を呼ぶたびに、日時・アプリ・版・文字数・かかった時間・成否を記録しています。"
      + (me.logContent ? "いまは入力文と応答文も記録しています（LOG_CONTENT が \"true\"）。" : "入力文と応答文は記録していません（LOG_CONTENT が \"false\"）。");
  } catch (e) { setErr($("#usageStatus"), "使用状況を取得できませんでした：" + e.message); }
}
$("#usageReload").onclick = loadUsage;

/* ============================================================
   つくる（ガイディング）
   ============================================================ */
let COURSE, CATALOG, PARTS, TOOL_CATS, TOOL_DESC, MAX_TOOLS, HOURS, APPX;
const LS = "lms-guiding-ai-v1";
let S = null;

function save() { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {} }

/* ---------------- helpers ---------------- */
function download(name, text, mime) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime || "text/plain;charset=utf-8" }));
  a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
async function copyText(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (e) {}
  try {  // fallback for browsers or pages where the Clipboard API is blocked
    const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.left = "-9999px"; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); if (ok) return true;
  } catch (e) {}
  return false;
}
async function copy(text, btn) {
  if (await copyText(text)) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = "コピーしました"; btn.classList.add("copied");
    clearTimeout(btn._t); btn._t = setTimeout(() => { btn.textContent = btn.dataset.label; btn.classList.remove("copied"); }, 1500);
  } else {  // last resort: show the text selected so Ctrl+C works
    $("#copyArea").value = text; $("#copyModal").classList.add("on");
    setTimeout(() => { $("#copyArea").focus(); $("#copyArea").select(); }, 30);
  }
}
$("#copyClose").onclick = () => $("#copyModal").classList.remove("on");
$("#copyModal").addEventListener("click", (e) => { if (e.target === $("#copyModal")) $("#copyModal").classList.remove("on"); });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function today() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function chapter(n) { return CATALOG.chapters.find(c => c.num === Number(n)); }
function sectionOf(id) { for (const c of CATALOG.chapters) { const s = c.sections.find(x => x.id === id); if (s) return { c, s }; } return null; }
function setStage(n) {
  S.stage = n; save();
  $$(".panel").forEach(p => p.classList.toggle("on", p.id === "p" + n));
  $$(".step").forEach(st => { const k = Number(st.dataset.s); st.classList.toggle("on", k === n); st.classList.toggle("done", k < n); });
  window.scrollTo({ top: 0 });
  if (n === 1) requestAnimationFrame(drawProfileLine);
  if (n === 5) showStage5();
}
$$(".step").forEach(st => st.onclick = () => { const k = Number(st.dataset.s); if (k <= maxStage()) setStage(k); });
function maxStage() { if (S.plan) return 5; if (S.flow) return 4; if (S.goal) return 3; return 2; }

/* ---------------- 科目の文言を差し込む ---------------- */
function fillTexts() {
  const c = COURSE.course, t = COURSE.texts;
  document.title = c.app_title;
  $("#appTitle").textContent = c.app_title;
  $("#tx-stage1Lead").textContent = t.stage1_lead;
  $("#tx-maxTools").textContent = MAX_TOOLS;
  $("#free").placeholder = t.free_placeholder || "";
  $("#tx-rolesTitle").textContent = t.roles.title;
  $("#tx-rolesAiLabel").textContent = t.roles.ai_label;
  $("#tx-rolesYouLabel").textContent = t.roles.you_label;
  $("#tx-rolesAiItems").innerHTML = t.roles.ai_items.map(x => "<li>" + esc(x) + "</li>").join("");
  $("#tx-rolesYouItems").innerHTML = t.roles.you_items.map(x => "<li>" + esc(x) + "</li>").join("");
  $("#tx-rolesNote").textContent = t.roles.note;
  $("#tx-planCalloutTitle").textContent = t.plan_callout.title;
  $("#tx-planCalloutBody").textContent = t.plan_callout.body;
  $("#appRequest").placeholder = t.app_request_placeholder || "";
  $("#footer").innerHTML = esc(c.app_title) + "　" + esc(c.name) + "<br>"
    + "入力した内容はこのブラウザに保存されます。AIの呼び出し（ステージ2・4・5）はサーバを経由します。APIキーはブラウザには届きません。";
}

/* ---------------- stage 1 ---------------- */
const LEVEL_POS = { known: 0, unsure: 1, unknown: 2 };

function drawProfileLine() {
  const svg = $("#profileLine"), box = $("#profile"); if (!svg || !box || !box.offsetParent) return;
  const R = box.getBoundingClientRect(); svg.setAttribute("viewBox", `0 0 ${R.width} ${R.height}`);
  const pts = $$("#chapters .prow .track button.on").map(b => { const r = b.querySelector("span").getBoundingClientRect(); return [r.left + r.width / 2 - R.left, r.top + r.height / 2 - R.top]; });
  svg.innerHTML = pts.length > 1 ? `<path d="M${pts.map(p => p[0].toFixed(1) + " " + p[1].toFixed(1)).join("L")}"/>` : "";
}
function profileFoot() {
  const cnt = { known: 0, unsure: 0, unknown: 0 };
  for (const c of CATALOG.chapters) cnt[S.pick.chapters[c.num] || "unsure"]++;
  $("#profileFoot").innerHTML = [["known", "分かった", "var(--known)"], ["unsure", "あいまい", "var(--unsure)"], ["unknown", "分からない", "var(--unknown)"]]
    .map(([k, n, c]) => `<div class="stat" style="--sc:${c}"><b>${cnt[k]}<small style="font-size:.6em;color:var(--ink-3)"> 章</small></b><span>${n}</span></div>`).join("");
}
function buildStage1() {
  // 1-1 understanding profile
  const cg = $("#chapters"); cg.innerHTML = "";
  for (const part of PARTS) {
    const band = document.createElement("div"); band.className = "pband"; band.style.setProperty("--pc", part.color); band.textContent = part.name; cg.appendChild(band);
    for (const num of part.chapters) {
      const c = chapter(num); if (!c) continue;
      const v = S.pick.chapters[c.num] || "unsure";
      const d = document.createElement("div"); d.className = "prow"; d.style.setProperty("--pc", part.color);
      d.innerHTML = `<div class="info"><span class="num">第${c.num}章 · ${esc(c.pages)}</span><span class="t">${esc(c.title)}</span><span class="pf">${esc(c.pitfalls.slice(0, 2).map(p => p.title).join("／"))}</span></div>
        <div class="track"><button type="button" data-v="known" aria-label="分かった"><span></span></button><button type="button" data-v="unsure" aria-label="あいまい"><span></span></button><button type="button" data-v="unknown" aria-label="分からない"><span></span></button></div>`;
      d.querySelectorAll("button").forEach(b => { b.classList.toggle("on", b.dataset.v === v); b.onclick = () => { S.pick.chapters[c.num] = b.dataset.v; d.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); drawProfileLine(); profileFoot(); sum1(); save(); }; });
      cg.appendChild(d);
    }
  }
  profileFoot(); requestAnimationFrame(drawProfileLine);
  // 1-2 tools by category, max N
  const tg = $("#tools"); tg.innerHTML = "";
  const paintAll = () => { $$("#tools .chip").forEach(x => x._paint()); $("#toolCount").textContent = S.pick.tools.length >= MAX_TOOLS ? `（${MAX_TOOLS}つ選びました。替えるには1つ外します）` : `（あと${MAX_TOOLS - S.pick.tools.length}つ選べます）`; };
  for (const cat of TOOL_CATS) {
    const tools = CATALOG.tools.filter(t => cat.chapters.includes(t.chapter)); if (!tools.length) continue;
    const box = document.createElement("div"); box.className = "toolcat"; box.style.setProperty("--pc", cat.color);
    box.innerHTML = `<h4>${esc(cat.name)}<small>${esc(cat.hint)}</small></h4><div class="chips"></div>`;
    const chips = box.querySelector(".chips");
    for (const t of tools) {
      const b = document.createElement("button"); b.className = "chip toolrow"; b.type = "button";
      b._paint = () => { const i = S.pick.tools.indexOf(t.id); b.classList.toggle("on", i >= 0); b.disabled = i < 0 && S.pick.tools.length >= MAX_TOOLS; b.innerHTML = `<span class="rk">${i >= 0 ? i + 1 : ""}</span><span class="tn">${esc(t.name)}</span><span class="td">${esc(TOOL_DESC[t.id] || "")}</span>`; };
      b.onclick = () => { const i = S.pick.tools.indexOf(t.id); if (i >= 0) S.pick.tools.splice(i, 1); else if (S.pick.tools.length < MAX_TOOLS) S.pick.tools.push(t.id); paintAll(); sum1(); save(); };
      chips.appendChild(b);
    }
    tg.appendChild(box);
  }
  S.pick.tools = S.pick.tools.filter(id => CATALOG.tools.some(t => t.id === id)).slice(0, MAX_TOOLS); paintAll();
  // 1-3 level ladder
  const lg = $("#levels"); lg.innerHTML = "";
  const nLv = CATALOG.levels.length;
  CATALOG.levels.forEach((l, i) => {
    const o = document.createElement("label"); o.className = "rung" + (S.pick.level === l.id ? " on" : "");
    o.style.setProperty("--lv", i);
    o.innerHTML = `<input type="radio" name="level" value="${esc(l.id)}" ${S.pick.level === l.id ? "checked" : ""}><span class="lv">レベル ${i + 1} / ${nLv}</span><b>${esc(l.name)}</b><span class="d">${esc(l.desc)}</span><div class="stair">${CATALOG.levels.map((_, k) => `<i class="${k <= i ? "on" : ""}" style="height:${Math.round(100 * (k + 1) / nLv)}%"></i>`).join("")}</div>`;
    o.querySelector("input").onchange = () => { S.pick.level = l.id; $$("#levels .rung").forEach(x => x.classList.toggle("on", x === o)); sum1(); save(); };
    lg.appendChild(o);
  });
  const hg = $("#hoursOpts"); hg.innerHTML = "";
  for (const h of HOURS) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = h; b.classList.toggle("on", S.pick.hours === h);
    b.onclick = () => { S.pick.hours = h; $$("#hoursOpts button").forEach(x => x.classList.toggle("on", x === b)); sum1(); save(); };
    hg.appendChild(b);
  }
  const dg = $("#deadlines"); dg.innerHTML = "";
  for (const d of CATALOG.deadlines) {
    const o = document.createElement("label"); o.className = "opt" + (S.pick.deadline === d.id ? " on" : "");
    o.innerHTML = `<input type="radio" name="dl" value="${esc(d.id)}" ${S.pick.deadline === d.id ? "checked" : ""}><div><b>${esc(d.name)}</b><span>${esc(d.date)}</span></div>`;
    o.querySelector("input").onchange = () => { S.pick.deadline = d.id; S.pick.customDate = ""; $("#customDate").value = ""; $$("#deadlines .opt").forEach(x => x.classList.toggle("on", x === o)); sum1(); save(); };
    dg.appendChild(o);
  }
  $("#customDate").value = S.pick.customDate || ""; $("#customDate").onchange = () => { S.pick.customDate = $("#customDate").value; if (S.pick.customDate) { S.pick.deadline = "custom"; $$("#deadlines .opt").forEach(x => { x.classList.remove("on"); x.querySelector("input").checked = false; }); } sum1(); save(); };
  $("#free").value = S.pick.free || ""; $("#free").oninput = () => { S.pick.free = $("#free").value; save(); };
  sum1();
}
window.addEventListener("resize", () => { if (S) drawProfileLine(); });
function deadlineDate() { if (S.pick.deadline === "custom" && S.pick.customDate) return S.pick.customDate; const d = CATALOG.deadlines.find(x => x.id === S.pick.deadline); return d ? d.date : CATALOG.deadlines[0].date; }
function weeksAvailable() { const ms = new Date(deadlineDate()) - new Date(today()); return Math.max(1, Math.round(ms / 6048e5)); }
function buildGoal() {
  const ch = {}; for (const c of CATALOG.chapters) ch[c.num] = S.pick.chapters[c.num] || "unsure";
  const lv = CATALOG.levels.find(l => l.id === S.pick.level) || CATALOG.levels[0];
  return { created: today(), chapters: ch,
    interests: S.pick.tools.map((id, i) => { const t = CATALOG.tools.find(x => x.id === id); return { rank: i + 1, id, name: t.name, sections: t.sections }; }),
    level: { id: lv.id, name: lv.name, desc: lv.desc }, hours_per_week: S.pick.hours, deadline: deadlineDate(), weeks_available: weeksAvailable(), free_text: S.pick.free || "" };
}
function goalSummary(g) {
  const u = Object.keys(g.chapters).filter(k => g.chapters[k] === "unknown").map(k => "第" + k + "章");
  const s = Object.keys(g.chapters).filter(k => g.chapters[k] === "unsure").map(k => "第" + k + "章");
  return `<b>選んだ内容</b><span>分からない：${u.length ? u.join("、") : "なし"}</span><span>あいまい：${s.length ? s.join("、") : "なし"}</span>
    <span>学びたい：${g.interests.length ? g.interests.slice(0, MAX_TOOLS).map(t => t.rank + " " + esc(t.name)).join("　") : "（未選択）"}</span>
    <span>到達点：${esc(g.level.name)}　週${g.hours_per_week}時間　期限 ${esc(g.deadline)}（約${g.weeks_available}週）</span>${g.free_text ? "<span>補足：" + esc(g.free_text) + "</span>" : ""}`;
}
function sum1() { $("#sum1").innerHTML = goalSummary(buildGoal()); }
function goalGraphic(g) {
  const lvIdx = CATALOG.levels.findIndex(l => l.id === g.level.id);
  const hit = new Set(g.interests.flatMap(t => t.sections.map(chapterNumOf)));
  const parts = PARTS.map(p => `<div class="gpart" style="--pc:${p.color}"><span class="pn">${esc(p.name)}</span>${p.chapters.map(n => { const c = chapter(n), v = g.chapters[n] || "unsure"; return c ? `<div class="gch ${v}${hit.has(n) ? " hit" : ""}"><i></i>第${n}章 ${esc(c.title)}</div>` : ""; }).join("")}</div>`).join("");
  const path = g.interests.length ? g.interests.map(t => `<span class="gt"><b>${t.rank}</b>${esc(t.name)}</span>`).join('<span class="arrow">→</span>') : '<span class="none">とくに学びたいことは選んでいません（理解度だけから設計します）</span>';
  const cnt = v => Object.values(g.chapters).filter(x => x === v).length;
  return `<h4>ガイドブックの地図と、いまの理解度</h4><div class="gmap" style="--parts:${PARTS.length}">${parts}</div>
    <div class="glegend"><span><i style="background:var(--unknown)"></i>分からない（必ず通る）${cnt("unknown")}章</span><span><i style="background:var(--unsure)"></i>あいまい（関心に応じて）${cnt("unsure")}章</span><span><i style="background:var(--known)"></i>分かった（前提として扱う）${cnt("known")}章</span><span><i style="background:none;color:var(--accent);width:auto;height:auto">★</i>学びたいことに関わる章</span></div>
    <h4>とくに学びたいこと（順位の順）</h4><div class="gpath">${path}</div>
    <h4>到達点と時間</h4><div class="gstats"><div class="gstat goal"><b>レベル${lvIdx + 1}　${esc(g.level.name)}</b><span>${esc(g.level.desc)}</span></div><div class="gstat"><b>週 ${g.hours_per_week} 時間 × 約 ${g.weeks_available} 週</b><span>使える時間の目安：${g.hours_per_week * g.weeks_available} 時間</span></div><div class="gstat"><b>${esc(g.deadline)}</b><span>期限${g.free_text ? "　補足：" + esc(g.free_text) : ""}</span></div></div>`;
}
$("#saveGoal").onclick = () => download("goal.json", JSON.stringify(buildGoal(), null, 2), "application/json");
$("#go2").onclick = () => {
  const g = buildGoal();
  const n = Object.values(g.chapters).filter(v => v !== "known").length;
  if (!n) { $("#st1").textContent = "すべて「分かった」です。学ぶ章がないので、少なくとも一つは「あいまい」か「分からない」にしてください。"; return; }
  $("#st1").textContent = "";
  S.goal = g; S.flow = null; S.plan = ""; save();
  $("#sum2").innerHTML = goalGraphic(g); $("#st2").textContent = ""; setStage(2);
};
$("#back1").onclick = () => setStage(1);

/* ---------------- stage 2: flow ---------------- */
async function genFlow() {
  $("#st2").innerHTML = '<span class="spin"></span>学習フローを作っています（30秒ほどかかることがあります）…'; $("#genFlow").disabled = true;
  try {
    const { flow } = await api("/api/flow", { goal: S.goal });
    S.flow = flow; S.plan = ""; save();
    renderFlow(); setStage(3); $("#st2").textContent = "";
  } catch (e) { $("#st2").className = "status err"; $("#st2").textContent = "失敗しました：" + e.message + "\nもう一度押して試してください。"; }
  finally { $("#genFlow").disabled = false; }
}
$("#genFlow").onclick = () => { $("#st2").className = "status"; genFlow(); };
$("#redoFlow").onclick = () => { setStage(2); $("#sum2").innerHTML = goalGraphic(S.goal); $("#st2").className = "status"; genFlow(); };
$("#back2").onclick = () => setStage(1);
$("#saveFlow").onclick = () => download("flow.json", JSON.stringify(S.flow, null, 2), "application/json");

/* ---------------- stage 3: flowchart ---------------- */
function orderNodes(f) {
  const byId = {}; f.nodes.forEach(n => byId[n.id] = n);
  const fwd = {}; f.edges.forEach(e => { if (e.label !== "no") (fwd[e.from] = fwd[e.from] || []).push(e.to); });
  const start = f.nodes.find(n => n.type === "start");
  const seen = new Set(), order = [];
  (function walk(id) { if (seen.has(id) || !byId[id]) return; seen.add(id); order.push(byId[id]); (fwd[id] || []).forEach(walk); })(start.id);
  f.nodes.forEach(n => { if (!seen.has(n.id)) order.push(n); });
  return order;
}
function renderFlow() {
  const f = S.flow, order = orderNodes(f), W = 700, cx = 380, gap = 100, pad = 44;
  const pos = {}; order.forEach((n, i) => pos[n.id] = { y: pad + i * gap, i });
  const H = pad + order.length * gap;
  const col = { start: "var(--line-strong)", goal: "var(--good)", read: "var(--p1)", check: "var(--warn)", apply: "var(--p4)" };
  let g = "";
  // edges
  for (const e of f.edges) {
    const a = pos[e.from], b = pos[e.to]; if (!a || !b) continue;
    if (e.label === "no") {
      const x = cx - 210, y1 = a.y, y2 = b.y;
      g += `<path d="M${cx - 118} ${y1}H${x}V${y2}H${cx - 130}" fill="none" stroke="var(--warn)" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar-w)"/>
            <text x="${x + 6}" y="${(y1 + y2) / 2 + 4}" font-size="11" fill="var(--warn)">no：戻る</text>`;
    } else if (b.i === a.i + 1) {
      g += `<path d="M${cx} ${a.y + 32}V${b.y - 34}" fill="none" stroke="var(--line-strong)" stroke-width="1.4" marker-end="url(#ar)"/>`;
      if (e.label === "yes") g += `<text x="${cx + 8}" y="${a.y + 58}" font-size="11" fill="var(--ink-3)">yes</text>`;
    } else {
      const x = cx + 210;
      g += `<path d="M${cx + 118} ${a.y}H${x}V${b.y}H${cx + 130}" fill="none" stroke="var(--line-strong)" stroke-width="1.4" marker-end="url(#ar)"/>`;
    }
  }
  // nodes
  const wrap = (t, n) => { t = String(t || ""); const a = []; while (t.length && a.length < 2) { a.push(t.slice(0, n)); t = t.slice(n); } if (t.length) a[1] = a[1].slice(0, n - 1) + "…"; return a; };
  const BW = 260;
  for (const n of order) {
    const y = pos[n.id].y, c = col[n.type] || col.read;
    let shape, sub = "";
    const lines = wrap(n.title, n.type === "check" ? 14 : 18);
    if (n.type === "start" || n.type === "goal") shape = `<rect x="${cx - BW / 2}" y="${y - 24}" width="${BW}" height="48" rx="24" fill="${c}" fill-opacity="${n.type === "goal" ? .18 : .1}" stroke="${c}" stroke-width="1.5"/>`;
    else if (n.type === "check") { shape = `<polygon points="${cx},${y - 34} ${cx + 140},${y} ${cx},${y + 34} ${cx - 140},${y}" fill="${c}" fill-opacity=".12" stroke="${c}" stroke-width="1.5"/>`; }
    else if (n.type === "apply") shape = `<rect x="${cx - BW / 2}" y="${y - 28}" width="${BW}" height="56" rx="6" fill="none" stroke="${c}" stroke-width="3"/><rect x="${cx - BW / 2 + 6}" y="${y - 22}" width="${BW - 12}" height="44" rx="4" fill="${c}" fill-opacity=".08" stroke="${c}" stroke-width="1"/>`;
    else { shape = `<rect x="${cx - BW / 2}" y="${y - 30}" width="${BW}" height="60" rx="8" fill="${c}" fill-opacity=".08" stroke="${c}" stroke-width="1.5"/>`; sub = (n.section ? n.section + "　" : "") + (n.minutes ? n.minutes + "分" : ""); }
    const two = lines.length > 1, base = two ? (sub ? y - 10 : y - 3) : (sub ? y - 2 : y + 5);
    let txt = `<text x="${cx}" y="${base}" text-anchor="middle" font-size="12.5" font-weight="600" fill="var(--ink)">${esc(lines[0] || "")}</text>`;
    if (two) txt += `<text x="${cx}" y="${base + 16}" text-anchor="middle" font-size="12.5" font-weight="600" fill="var(--ink)">${esc(lines[1])}</text>`;
    if (sub) txt += `<text x="${cx}" y="${two ? y + 22 : y + 16}" text-anchor="middle" font-size="11" fill="var(--ink-3)">${esc(sub)}</text>`;
    g += `<g class="nd" data-id="${esc(n.id)}" style="cursor:pointer">${shape}${txt}</g>`;
  }
  $("#flowbox").innerHTML = `<svg viewBox="0 0 ${W + 60} ${H}" role="img" aria-label="学習フロー"><defs>
    <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--line-strong)"/></marker>
    <marker id="ar-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--warn)"/></marker></defs>${g}</svg>`;
  $$("#flowbox .nd").forEach(el => el.onclick = () => showNode(el.dataset.id));
  const sm = f.summary || {};
  $("#flowNote").textContent = `ステップ数 ${sm.steps}、合計の目安 ${sm.total_minutes}分（約${Math.round(sm.total_minutes / 60 * 10) / 10}時間）。使える時間は 週${S.goal.hours_per_week}時間 × ${S.goal.weeks_available}週 ＝ ${S.goal.hours_per_week * S.goal.weeks_available}時間。` + (sm.note ? "　" + sm.note : "");
  showNode(order[0].id);
}
function showNode(id) {
  const n = S.flow.nodes.find(x => x.id === id); if (!n) return;
  const names = { start: "現在地", read: "読む", check: "確認問題", apply: "自分の問題に当てる（自分で考える）", goal: "到達点" };
  let h = `<span class="k">${names[n.type] || esc(n.type)}</span><b>${esc(n.title || "")}</b>`;
  if (n.section) { const so = sectionOf(n.section); h += `<p>ガイドブック <b>${esc(n.section)}</b>${so ? " " + esc(so.s.title) + "（第" + so.c.num + "章）" : ""}</p>`; }
  if (n.minutes) h += `<p>所要時間の目安：${esc(n.minutes)}分</p>`;
  if (n.check) h += `<p><b>問い</b>：${esc(n.check)}</p>`;
  if (n.pitfalls && n.pitfalls.length) h += `<p><b>つまずきやすい点</b></p><ul style="margin:0;padding-left:1.2em">${n.pitfalls.map(p => "<li>" + esc(p) + "</li>").join("")}</ul>`;
  if (n.type === "apply") h += `<p class="note">このノードの中身はエージェントが考えません。あなたが自分で書きます。</p>`;
  $("#detail").innerHTML = h;
}
$("#go4").onclick = () => { setStage(4); if (!S.plan) genPlan(); else showPlan(); };

/* ---------------- steps: one grouping of the flow, shared by the plan (stage 4) and the app (stage 5) ---------------- */
function chapterNumOf(sec) { const m = String(sec || "").match(/^(\d+)(-|$)/); return m ? Number(m[1]) : null; }
function appendixInfo() { return APPX; }  // サーバが guidebook.md から作って /api/course で渡す
function canonPitfall(p, chNums) {  // prefer the catalog wording; split "題：説明" otherwise
  const s = String(p || "").trim();
  for (const n of chNums) { const c = chapter(n); if (!c) continue; for (const q of c.pitfalls) if (s.indexOf(q.title) >= 0) return { mistake: q.title, advice: q.text }; }
  const i = s.indexOf("：");
  return i > 0 ? { mistake: s.slice(0, i), advice: s.slice(i + 1) } : { mistake: s, advice: "" };
}
function deriveSteps(f) {
  if (!f || !Array.isArray(f.nodes)) return [];
  const byId = {}; f.nodes.forEach(n => byId[n.id] = n);
  const groups = []; let cur = null;
  for (const n of orderNodes(f)) {
    if (n.type === "read") {  // consecutive reads of one chapter before its check form one step
      const last = cur && cur.kind === "read" && !cur.checks.length && cur.reads[cur.reads.length - 1];
      if (last && chapterNumOf(last.section) === chapterNumOf(n.section)) cur.reads.push(n);
      else { cur = { kind: "read", reads: [n], checks: [] }; groups.push(cur); }
    } else if (n.type === "check") {
      if (cur && cur.kind === "read") cur.checks.push(n);
      else { cur = { kind: "read", reads: [], checks: [n] }; groups.push(cur); }
    } else if (n.type === "apply") { cur = { kind: "apply", node: n }; groups.push(cur); }
  }
  return groups.map((g, i) => {
    if (g.kind === "apply") {
      let t = String(g.node.title || "自分の問題に当てる").trim();
      if (t.indexOf("自分で考える") < 0) t += "（自分で考える）";
      return { no: i + 1, kind: "apply", title: t };
    }
    const secs = [];
    for (const r of g.reads) if (r.section && !secs.some(x => x.id === r.section)) {
      const so = sectionOf(r.section);
      secs.push({ id: r.section, title: so ? so.s.title : String(r.title || ""), heading: so ? "### " + r.section + " " + so.s.title : "" });
    }
    const minutes = g.reads.reduce((a, r) => a + (Number(r.minutes) || (sectionOf(r.section) ? sectionOf(r.section).s.minutes : 0)), 0);
    const chNums = [...new Set(secs.map(x => chapterNumOf(x.id)).concat(g.checks.map(c => chapterNumOf(c.section))).filter(Boolean))];
    const pitfalls = [], seen = new Set();
    for (const r of g.reads) for (const p of (r.pitfalls || [])) { const c = canonPitfall(p, chNums); if (c.mistake && !seen.has(c.mistake)) { seen.add(c.mistake); pitfalls.push(c); } }
    const checks = g.checks.map(c => {
      const no = (f.edges || []).find(e => e.from === c.id && e.label === "no"), t = no && byId[no.to];
      return { question: String(c.check || c.title || "").trim(), back: t && t.type === "read" && t.section ? t.section : (secs[0] ? secs[0].id : "") };
    }).filter(c => c.question);
    const title = secs.length ? secs.map(x => x.id + " " + x.title).join("／") : String((g.checks[0] && g.checks[0].title) || "確認問題");
    const AI = appendixInfo(), letters = [...new Set(secs.flatMap(x => AI.refs[x.id] || []))].sort();
    const step = { no: i + 1, kind: "read", title, minutes, sections: secs.map(x => ({ id: x.id, heading: x.heading })) };
    const appendices = letters.filter(a => AI.heads[a]).map(a => ({ id: "付録" + a, heading: AI.heads[a] }));
    if (appendices.length) step.appendices = appendices;
    return Object.assign(step, { checks, pitfalls });
  });
}

/* ---------------- markdown ---------------- */
function inline(s) { return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>"); }
let MD_BLOCKS = [];  // raw text of each code block from the last md() call, for the copy buttons
function md(src) {
  const lines = src.replace(/\r/g, "").split("\n"); let out = "", list = null, i = 0;
  MD_BLOCKS = [];
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  while (i < lines.length) {
    let l = lines[i];
    const fm = l.match(/^(`{3,})/);
    if (fm) {  // a fence closes only on a line of at least as many backticks
      close(); const endRe = new RegExp("^`{" + fm[1].length + ",}\\s*$"); const code = []; i++;
      while (i < lines.length && !endRe.test(lines[i])) code.push(lines[i++]);
      i++;
      const k = MD_BLOCKS.push(code.join("\n")) - 1;
      out += `<div class="codeblk" data-ci="${k}"><div class="cbar"><span class="clabel"></span><button type="button" class="btn small cbtn" data-ci="${k}">コピー</button></div><pre><code>${esc(code.join("\n"))}</code></pre></div>`;
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,3}) (.+)/))) { close(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
    else if ((m = l.match(/^> ?(.*)/))) { close(); out += `<blockquote>${inline(m[1])}</blockquote>`; }
    else if ((m = l.match(/^\s*[-*] \[( |x)\] (.+)/))) { if (list !== "ul") { close(); out += "<ul>"; list = "ul"; } out += `<li class="task"><input type="checkbox" disabled ${m[1] === "x" ? "checked" : ""}> ${inline(m[2])}</li>`; }
    else if ((m = l.match(/^\s*[-*] (.+)/))) { if (list !== "ul") { close(); out += "<ul>"; list = "ul"; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+\. (.+)/))) { if (list !== "ol") { close(); out += "<ol>"; list = "ol"; } out += `<li>${inline(m[1])}</li>`; }
    else if (!l.trim()) { close(); }
    else { close(); out += `<p>${inline(l)}</p>`; }
    i++;
  }
  close(); return out;
}
function renderMd(el, src) {  // render Markdown into el and wire each code block's copy button
  el.innerHTML = md(src); const blocks = MD_BLOCKS.slice();
  el.querySelectorAll(".cbtn").forEach(b => b.onclick = () => copy(blocks[Number(b.dataset.ci)], b));
  return blocks;
}

/* ---------------- stage 4: plan ---------------- */
async function genPlan() {
  $("#st4").className = "status"; $("#st4").innerHTML = '<span class="spin"></span>学習計画を書いています…'; $("#planView").innerHTML = ""; $("#go5").disabled = true;
  try {
    const { plan } = await api("/api/plan", { goal: S.goal, flow: S.flow, steps: deriveSteps(S.flow) });
    S.plan = plan; save(); showPlan(); $("#st4").textContent = "";
  } catch (e) { $("#st4").className = "status err"; $("#st4").textContent = "失敗しました：" + e.message; }
  finally { $("#go5").disabled = !S.plan; }
}
function showPlan() { renderMd($("#planView"), S.plan); $("#planRaw").value = S.plan; $("#go5").disabled = !S.plan; }
$("#viewRender").onclick = () => { $("#planView").style.display = ""; $("#planRaw").style.display = "none"; };
$("#viewRaw").onclick = () => { $("#planView").style.display = "none"; $("#planRaw").style.display = ""; };
$("#copyPlan").onclick = (e) => copy(S.plan, e.target);
$("#savePlan").onclick = () => download("plan.md", S.plan, "text/markdown;charset=utf-8");
$("#back3").onclick = () => setStage(3);
$("#redoPlan").onclick = () => genPlan();
$("#go5").onclick = () => setStage(5);

/* ---------------- stage 5: アプリを生成する（この LMS で置き換えた部分） ---------------- */
function planTitle(p) { const m = String(p || "").match(/^#\s+(.+)$/m); return m ? m[1].trim() : "学習計画"; }
function showStage5() {
  if (!S.goal || !S.flow || !S.plan) { $("#sum5").innerHTML = "<span>学習計画がまだありません。ステージ1から進めてください。</span>"; $("#genApp").disabled = true; return; }
  const steps = deriveSteps(S.flow), sm = S.flow.summary || {};
  $("#sum5").innerHTML = goalSummary(S.goal)
    + `<span>学習フロー：ステップ ${steps.length}（${steps.filter(s => s.kind === "apply").length ? "自分で考えるステップを含む・" : ""}合計の目安 ${esc(sm.total_minutes)}分）</span>`
    + `<span>計画名：${esc(planTitle(S.plan).replace(/^学習計画[：:]\s*/, ""))}</span>`;
  $("#appRequest").value = S.appRequest || "";
  $("#genApp").disabled = false;
}
$("#appRequest").oninput = () => { S.appRequest = $("#appRequest").value; save(); };
$("#back4").onclick = () => setStage(4);
$("#saveAll").onclick = () => {
  download("goal.json", JSON.stringify(S.goal, null, 2), "application/json");
  setTimeout(() => download("flow.json", JSON.stringify(S.flow, null, 2), "application/json"), 300);
  setTimeout(() => download("plan.md", S.plan, "text/markdown"), 600);
};
$("#genApp").onclick = async () => {
  if (!S.goal || !S.flow || !S.plan) return;
  $("#genApp").disabled = true; $("#back4").disabled = true;
  const stop = progress($("#st5"), "アプリを作っています。30〜90秒かかることがあります。このページを閉じずにお待ちください");
  try {
    const { app } = await api("/api/generate", { goal: S.goal, flow: S.flow, plan: S.plan, steps: deriveSteps(S.flow), request: $("#appRequest").value });
    stop(); $("#st5").className = "status"; $("#st5").textContent = "アプリを作りました。ライブラリで開いています。";
    openApp(app.id);
  } catch (e) { stop(); setErr($("#st5"), "アプリを作れませんでした：" + e.message); }
  finally { $("#genApp").disabled = false; $("#back4").disabled = false; }
};

/* ---------------- reset / boot ---------------- */
$("#btnReset").onclick = () => { if (!confirm("入力した内容と生成したものをすべて消して、最初からにします。よろしいですか？\n（ライブラリに保存したアプリは消えません）")) return; try { localStorage.removeItem(LS); } catch (e) {} location.reload(); };

async function boot() {
  try {
    COURSE = await api("/api/course");
  } catch (e) {
    $("#bootErr").textContent = "科目の内容を読み込めませんでした：" + e.message; return;
  }
  CATALOG = COURSE.catalog;
  const color = (c) => /^p\d$/.test(c) ? "var(--" + c + ")" : c;
  PARTS = COURSE.parts.map(p => Object.assign({}, p, { color: color(p.color) }));
  TOOL_CATS = COURSE.tool_categories.map(p => Object.assign({}, p, { color: color(p.color) }));
  TOOL_DESC = {}; CATALOG.tools.forEach(t => TOOL_DESC[t.id] = t.desc || "");
  MAX_TOOLS = COURSE.stage1.max_tools || 4;
  HOURS = COURSE.stage1.hours_options || [1, 2, 3, 4, 5, 6, 8, 10];
  APPX = COURSE.appendix || { refs: {}, heads: {} };
  const D = COURSE.stage1.defaults || {};

  S = { stage: 1, goal: null, flow: null, plan: "", appRequest: "",
    pick: { chapters: {}, tools: [], level: D.level || CATALOG.levels[0].id, hours: D.hours || HOURS[0], deadline: D.deadline || CATALOG.deadlines[0].id, customDate: "", free: "" } };
  try { const s = JSON.parse(localStorage.getItem(LS) || "null"); if (s && s.pick) S = Object.assign(S, s); } catch (e) {}

  fillTexts();
  buildStage1();
  if (S.goal) { $("#sum2").innerHTML = goalGraphic(S.goal); }
  if (S.flow) { try { renderFlow(); } catch (e) { S.flow = null; S.plan = ""; } }
  if (S.plan) { showPlan(); }
  setStage(Math.min(S.stage || 1, maxStage()));
  let tab = "make", openId = "";
  try { tab = sessionStorage.getItem(TAB_KEY) || "make"; openId = sessionStorage.getItem(OPEN_KEY) || ""; } catch (e) {}
  if (openId) openApp(openId, tab === "app");
  if (!(openId && tab === "app")) showTab(tab !== "app" && $("#tab-" + tab) ? tab : "make");
}
boot();
})();
