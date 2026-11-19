# LMS型ガイディングAI

自分専用の学習支援AIアプリを、**生成・改訂・保存・実行**できる、1人用のLMS（学習管理システム）です。

1. **つくる**：学習目標を選び（ステージ1）、AI が学習フローと学習計画を作ります（ステージ2〜4）。その計画から、あなた専用の学習支援アプリを AI が作ります（ステージ5）。
2. **ライブラリ**：作ったアプリを保存します。アプリを開くと、プレビューの横に学習の進み具合（完了したステップ、学習前後の自己評価、確認問題の合格までの回数）が出ます。「アプリ設定」で、文字の大きさと AI の返事の長さを変えられ、アプリの更新や前の版に戻すこともできます。アプリは、独立したページ（専用のURL）としても使えます。学習は途中で中断でき、進み具合・会話・メモはサーバに保存されるので、パソコンで中断してスマートフォンで再開できます。
3. **使用状況**：今日の使用回数と上限、利用ログ（CSV）を見られます。

Cloudflare Workers ＋ D1（データベース）で動きます。**1回のデプロイ＝1人用**です。

---

## 1. 自分の Cloudflare にデプロイする

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tatarat-code/lms-guiding-ai)

1. 上のボタンを押し、自分の Cloudflare アカウントでログインします（GitHub アカウントとの連携も求められます）。
2. 画面の案内に沿って進みます。
   - **Git account**：「New GitHub connection」を押して、自分の GitHub アカウントをつなぎます。
   - **Create private Git repository**：**チェックを入れます**（自分の写しを、人から見えない private にします）。private でも、push するたびに自動でデプロイされます。
   - **プロジェクト名（Worker の名前）**：そのままでも、自分で決めても構いません（半角の英小文字・数字・ハイフン）。
   - **データベース（D1）**：自動で作られます。名前はそのままで構いません。
   - **Secret（秘密の値）**：次の「2. 3つの Secret」の3つを入力します。
3. 「Deploy」を押します。数分で完了し、`https://<名前>.<アカウント名>.workers.dev` が表示されます。

> **初めて GitHub をつないだときの注意**
> GitHub の認証のあと、「**Select a repository**」（自分の GitHub のリポジトリを選ぶ画面）に移ることがあります。この画面では **何も選ばずに閉じ**、このページの「Deploy to Cloudflare」ボタンを **もう一度押して** ください。2回目は GitHub がつながった状態で設定画面が開くので、入力を確かめてから「Deploy」を押します。
4. そのアドレスを開き、自分で決めたパスワードでログインします。

> ボタンを押すと、このリポジトリの写しが **あなたの GitHub アカウント** に作られます。その写しを書き換えて push すると、公開版も自動で新しくなります。
> 写しにはキーもパスワードも入りませんが、あとで指示書や `content/` を自分で書き換えることがあるので、private にしておくと安心です。

## 2. 3つの Secret（秘密の値）

デプロイのときに聞かれます。あとから変えるときは、ダッシュボードの **Workers & Pages → 自分の Worker → 設定 → 変数とシークレット** で変えます。

| 名前 | 意味 | 入れる値 |
|---|---|---|
| `GEMINI_API_KEY` | AI（Gemini）を呼ぶためのキー | 授業で配布されたキー（`AIza` で始まる文字列） |
| `APP_PASSWORD` | LMS にログインするためのパスワード | 自分で決めた文字列。**12文字以上**を推奨 |
| `OWNER_EMAIL` | 持ち主（自分）のメールアドレス | 自分のメールアドレス。Cloudflare Access を有効にしたとき、本人かどうかの照合に使います |

## 3. Cloudflare Access を有効にする（より安全にする）

パスワードに加えて、**自分のメールアドレスに届く確認コード**でも本人確認をするようにできます。

1. Cloudflare のダッシュボードで **Workers & Pages → 自分の Worker → 設定 → ドメインとルート** を開きます。
2. **workers.dev** の行で、Cloudflare Access を **有効** にします。
3. **プレビューURL** の行でも、Cloudflare Access を **有効** にします。
4. 「Access を管理」から、作られたアプリケーションのポリシーを開き、**許可するメールアドレスに自分のアドレスだけ** を登録します。
5. ログイン方法は **ワンタイムPIN**（メールに届くコード）を選びます。
6. Secret の `OWNER_EMAIL` が、手順4で登録したアドレスと同じか確かめます。

> **重要：workers.dev とプレビューURLの両方を保護してください。** 片方だけだと、もう片方のアドレスから Access を通らずに入れてしまいます。

有効になると、LMS の「使用状況」タブに「Access 有効：〇〇@… と一致」と表示されます。`OWNER_EMAIL` と違うメールアドレスで入ろうとすると、403（入れません）になります。

## 4. パスワードを変える

1. ダッシュボードの **Workers & Pages → 自分の Worker → 設定 → 変数とシークレット** を開きます。
2. `APP_PASSWORD` の値を新しいパスワードに書き換えて、保存（デプロイ）します。

パスワードを変えると、それまでのログインはすべて無効になります。新しいパスワードでログインし直してください。

## 5. AI のモデルを差し替える

モデルは `wrangler.jsonc` の `vars` で決めています。

| 名前 | 使う場面 | 既定値 |
|---|---|---|
| `GEMINI_MODEL_BUILD` | 学習フロー・学習計画・アプリの生成と作り直し | `gemini-3.8-flash` |
| `GEMINI_MODEL_RUN` | ライブラリのアプリが AI を呼ぶとき | `gemini-3.8-flash` |

差し替えるときは、**自分の GitHub リポジトリ**で `wrangler.jsonc` の `GEMINI_MODEL_BUILD` の値を、たとえば Pro 系のモデル名に書き換えて commit します。push されると、自動で公開版に反映されます。

> ダッシュボードの「変数」で直接変えても、次に push したときに `wrangler.jsonc` の値に戻ります。`wrangler.jsonc` で変えてください。

同じ場所で、1日の上限（`DAILY_LIMIT_GENERATE`＝生成・改訂、`DAILY_LIMIT_RUN`＝実行）と、入力文・応答文を記録するか（`LOG_CONTENT`）も変えられます。上限は日本時間の0時に元に戻ります。

## 6. 注意：APIキーをリポジトリやファイルに書かない

- APIキー・パスワード・メールアドレスは、**Cloudflare の Secret**（公開版）と **`.dev.vars`**（手元）にだけ置きます。
- `wrangler.jsonc`、`public/` の中のファイル、README などには **絶対に書きません**。リポジトリは公開されています。
- `git status` に `.dev.vars` が表示されたら、add も commit もしないでください（`.gitignore` で除外してあります）。
- 生成したアプリの HTML にも、キーやシステムプロンプトは入りません。AI はサーバ（`/api/run/`）を通して呼びます。

---

## 手元で動かす（開発する人向け）

Node.js 22 以上が必要です。

1. 部品をそろえます。

   ```
   npm install
   ```

2. `.dev.vars.example` を見本に、同じフォルダに `.dev.vars` を作り、3つの値を書きます（`=` の前後に空白を入れない）。
3. 起動して、ブラウザで `http://localhost:8787` を開きます。止めるときは `x` キーです。

   ```
   npx wrangler dev
   ```

手元のデータベースは `.wrangler/` に作られます（GitHub には送られません）。

> `npm install` のとき「install scripts not yet covered by allowScripts」という警告が出ることがあります。このアプリの動作には影響しません。

## ファイルの役割

| ファイル | 役割 | 主に触る人 |
|---|---|---|
| `content/course.json` | 科目名・ステージ1の選択肢（章・節・道具・到達レベル・期限）・画面の文言・指示書に差し込む科目固有の決まり | **教員**（科目ごとに差し替え） |
| `content/guidebook.md` | ガイドブック本文（アプリ生成の材料と、ダウンロード用） | **教員** |
| `src/prompts/` | AI への指示書（`flow.js` 学習フロー、`plan.js` 学習計画、`build.js` アプリ生成、`revise.js` 作り直し） | **教員** |
| `public/` | 画面（ログイン画面と LMS 画面） | AI |
| `src/` のほかのファイル | サーバの処理（ログイン、データベース、Gemini の呼び出し、検査、上限など） | AI |
| `wrangler.jsonc` | Worker の名前・モデル・上限などの設定 | 必要に応じて |
| `.dev.vars.example` | `.dev.vars` の書き方の見本（Deploy ボタンが聞く Secret の一覧も兼ねる） | 見るだけ |
| `AGENTS.md` / `CLAUDE.md` | AIコーディングツールへのルール | 必要に応じて |

### 科目を変えるとき

`content/course.json` と `content/guidebook.md` を差し替えます。ガイドブックは、節の見出しを `### 1-1 見出し`、付録を `## 付録A　見出し` の形にしておくと、学習フローや付録の参照と結びつきます。

---

## 教員向けメモ：公開リポジトリにする手順

このフォルダで、初回だけ次を実行します（`reference/` は `.gitignore` で除外してあるので、GitHub には上がりません）。

```
git init -b main
git add .
git commit -m "LMS型ガイディングAIの初版"
gh repo create tatarat-code/lms-guiding-ai --public --source . --push
```

- Deploy ボタンを使うには、このリポジトリ（ボタンの元）が **Public** である必要があります。受講者それぞれに作られる写しは private で構いません。
- リポジトリ名を変えたときは、この README の Deploy ボタンの URL（`?url=https://github.com/…`）も合わせて直します。
- 公開する前に、別の Cloudflare アカウントでボタンを押し、最後まで動くことを確かめます。
