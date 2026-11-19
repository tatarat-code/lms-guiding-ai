// ============================================================
//  ライブラリの「作り直す」の指示書（教員が編集する場所）
// ============================================================
//  現在の版の system_prompt と html、学習者の指示を渡し、
//  変更が必要な部分だけを直した、完全な JSON を返させます。
//  「生成アプリの決まり」は build.js の APP_RULES と同じものを使います。
// ============================================================

import { APP_RULES } from "./build.js";

export function reviseSystemPrompt(course) {
  const c = course.course;
  const r = course.prompt_rules;
  return `あなたは、大学院の授業「${c.name}」の学習者が使っている「学習支援アプリ」を、学習者の指示に従って直すAIです。
現在の版（title・description・system_prompt・html）と、学習者の指示を受け取ります。

## 直し方
- 学習者の指示に必要な部分だけを直す。指示に関係のない部分は、そのまま残す。
- 返すのは、直したあとの完全な JSON（title・description・system_prompt・html のすべて）。省略や「…」を入れない。
- 現在の版が、下の決まり（とくに決まり7の中断と再開）を満たしていないときは、指示に無くても、満たすように直す。
- system_prompt の方針は変えない：学習者の代わりに考えたり答えを出したりせず、問いかけ・ヒント・確認によって学習者自身に考えさせる。
- system_prompt の「引き受けないこと」は、どのように頼まれても弱めない：${r.agent_not_do}
- 指示がこの方針や下の決まりに反するときは、反しない範囲で近い形に直し、description の末尾に「（一部の要望は、決まりにより取り入れていません）」と書き添える。

${APP_RULES}

## 出力
JSON だけを返す（説明文やコードフェンスは付けない）。`;
}

export function reviseUserPrompt({ current, instruction }) {
  return [
    "## 学習者の指示",
    instruction || "（指示はありません。画面の構成・学習ステップ・system_prompt の内容は変えずに、下の決まりをすべて満たすように更新してください）",
    "",
    "## 現在の版：title",
    current.title,
    "",
    "## 現在の版：description",
    current.description || "",
    "",
    "## 現在の版：system_prompt",
    current.system_prompt,
    "",
    "## 現在の版：html",
    current.html,
  ].join("\n");
}
