# LMS型ガイディングAI 要件定義（Claude Code 用）

> このファイルを Claude Code に渡し、この要件定義に沿って実装してください。
> 実装は「6. 実装の順序」のフェーズごとに区切り、各フェーズの終わりで動作確認の手順を示してから次へ進んでください。
> 不明点があれば、実装前に質問してください。

---

## 1. 目的

学習者が自分専用の学習支援AIアプリを**生成・改訂・保存・実行**できる、1人用のエージェント型LMSを作る。

- ガイディングAI（既存の `guiding-ai_V3.html`）のステージ1〜4（学習目標の選択 → 学習フロー → 学習計画）をそのまま使う。
- ステージ5を「Vibeコーディング用プロンプトの生成」から「**AIアプリの生成**」に置き換える。
- 生成したアプリは**ライブラリ**として保存・管理する（Difyと同じ考え方）。
- ライブラリのアプリは、LMSの画面でプレビューでき、**独立したWebアプリ**（専用URL）としても動く。
- 完成品は GitHub の公開リポジトリに置き、受講者が **Deploy to Cloudflare ボタン**で各自の Cloudflare にデプロイする。

## 2. 前提と制約

| 項目 | 内容 |
|---|---|
| 実行基盤 | Cloudflare Workers（無料プラン）＋静的アセット＋D1 |
| 開発環境 | Node.js 22 以上、wrangler 4.x、Windows 11 / macOS |
| 言語・構成 | 素の JavaScript（ES Modules）。フレームワーク・ビルド工程・npm の実行時依存は使わない |
| AI | Gemini API（REST の `generateContent`）。SDKは使わず `fetch` で呼ぶ |
| 利用者 | **1デプロイ＝1人**。複数ユーザー機能は作らない |
| 画面の言語 | 日本語 |
| 土台 | 教員のテンプレート `tatarat-code/template_triz2026` のファイル構成とコードの書き方にそろえる |
| 汎用性 | 科目に依存しない。科目固有の内容（ガイドブック・目標の選択肢）は `content/` のファイル差し替えだけで変えられること |
| CPU時間 | 無料プランの CPU 制限に収まるよう、重い計算（パスワードの多回ハッシュ等）はしない。AIの応答待ちは CPU 時間に数えられない |

### 環境変数

Secret（`.dev.vars.example` に書くのはこの3つだけ）:

| 名前 | 内容 |
|---|---|
| `GEMINI_API_KEY` | 受講者が配布キーを入力する |
| `APP_PASSWORD` | 受講者が自分で決めるログイン用パスワード（12文字以上を推奨と画面で案内） |
| `OWNER_EMAIL` | 受講者本人のメールアドレス（Cloudflare Access 導入後の照合用） |

通常の変数（`wrangler.jsonc` の `vars`）:

| 名前 | 既定値 | 内容 |
|---|---|---|
| `GEMINI_MODEL_BUILD` | `gemini-3.8-flash` | アプリ生成・改訂に使うモデル。教員が後で Pro 系に差し替える |
| `GEMINI_MODEL_RUN` | `gemini-3.8-flash` | 独立アプリの実行に使うモデル |
| `DAILY_LIMIT_GENERATE` | `30` | 1日の生成・改訂の上限回数 |
| `DAILY_LIMIT_RUN` | `300` | 1日の実行（`/api/run`）の上限回数 |
| `LOG_CONTENT` | `"false"` | `"true"` のときだけ、実行時の入力文と応答文を記録する |

日付の区切りは日本時間（JST）の0時とする。

## 3. 画面

### 3-1. ログイン画面（`/login`）
- パスワード入力欄と「ログイン」ボタンだけ。
- 失敗時は「パスワードが違います」とだけ表示する。

### 3-2. LMS画面（`/`）
上部にタブを3つ置く。

1. **つくる**（ガイディング）
   - ステージ1〜4は `reference/guiding-ai_V3.html` から UI とロジックを移植する（見た目・操作を変えない）。
   - ステージ5を「アプリを生成する」に置き換える：
     - ステージ1〜4の結果の要約を表示する。
     - 任意の追加要望の入力欄（例：「クイズ形式にしたい」）。
     - 「アプリを生成」ボタン → 生成中は進行表示（30〜90秒かかることがある旨を表示）→ 完了したらライブラリのそのアプリを開く。
   - 既存ドラフトにあった「APIキーの都度入力」欄は削除する（キーはサーバ側の Secret を使う）。
2. **ライブラリ**
   - 生成したアプリをカードで一覧表示（タイトル・説明・版番号・更新日時）。
   - カードを開くと詳細画面：
     - プレビュー（`<iframe src="/a/<slug>">`）
     - 「新しいタブで開く」（独立URL）
     - 作り直しの指示欄＋「作り直す」ボタン（新しい版として保存）
     - 版の履歴（版番号・日時・そのときの指示）と「この版に戻す」
     - 「HTMLを書き出す」（現在の版の HTML をダウンロード。キーもプロンプトも含まないこと）
     - 「削除」（確認ダイアログあり）
3. **使用状況**
   - 今日の生成回数・実行回数と上限。
   - 利用ログの CSV ダウンロード。
   - Cloudflare Access の照合状態の表示（「Access 未設定：パスワードのみ」／「Access 有効：〇〇@… と一致」）。

### 3-3. 独立アプリ（`/a/<slug>`）
- 保存されている現在の版の HTML をそのまま返す（4-4 参照）。

## 4. サーバ（Worker）の仕様

### 4-1. ルーティングと認証
- `wrangler.jsonc` の `assets` は `run_worker_first: true` とし、すべてのリクエストをまず Worker が受ける。
- 認証なしで通すもの：`/login`、`/api/login`、ログイン画面で使う CSS・JS。
- それ以外はすべてログインが必要。未ログインなら、画面は `/login` へリダイレクト、API は 401 を返す。

**ログイン（パスワード）**
- `POST /api/login {password}`：`APP_PASSWORD` と定数時間で比較する。
- 成功したら Cookie `lms_session` を発行する。値は「有効期限（UNIX秒）＋ HMAC-SHA256 署名」。署名の鍵は `APP_PASSWORD` から導出する（パスワードを変えると既存のログインは無効になる）。セッション用のテーブルは作らない。
- Cookie 属性：`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`（7日）。
- 連続失敗の抑止：直近15分の失敗が10回を超えたら 429 を返す（D1 の `login_attempts` に記録）。
- `POST /api/logout`：Cookie を消す。

**Cloudflare Access との照合（段階2）**
- リクエストに `Cf-Access-Authenticated-User-Email` ヘッダがあり、かつ `OWNER_EMAIL` が設定されている場合は、両者が一致しなければ 403 を返す（大文字・小文字は区別しない）。
- ヘッダが無い場合（Access 未設定）は、パスワードだけで通す。
- README に「Access を有効にするときは、workers.dev とプレビューURLの両方を保護すること」と明記する。

### 4-2. API 一覧

| メソッドとパス | 内容 |
|---|---|
| `GET /api/me` | ログイン状態・Access照合状態・今日の使用回数と上限 |
| `GET /api/course` | `content/course.json` の内容（ステージ1の選択肢など） |
| `GET /api/apps` | アプリ一覧 |
| `GET /api/apps/:id` | アプリの詳細（現在の版の system_prompt と html を含む） |
| `GET /api/apps/:id/versions` | 版の履歴（html は含めない） |
| `POST /api/generate` | ステージ1〜4の結果と追加要望から新しいアプリを生成し、版1として保存 |
| `POST /api/apps/:id/revise {instruction}` | 現在の版と指示から新しい版を生成して保存 |
| `POST /api/apps/:id/restore {version}` | 指定した版の内容で新しい版を作る（履歴は消さない） |
| `DELETE /api/apps/:id` | アプリとその版をすべて削除 |
| `GET /api/apps/:id/export` | 現在の版の HTML を添付ファイルとして返す |
| `POST /api/run/:slug {input, history}` | 独立アプリからの AI 呼び出し（4-4） |
| `GET /api/logs.csv` | 利用ログの CSV |

生成・改訂・実行の前に1日の上限を確認し、超えていれば 429 と「今日の上限に達しました」を返す。

### 4-3. アプリの生成（`/api/generate`・`revise`）

**Gemini への依頼**
- モデルは `GEMINI_MODEL_BUILD`。
- `generationConfig` に `responseMimeType: "application/json"` と `responseSchema` を指定し、次の JSON を返させる：
  ```json
  { "title": "…", "description": "…", "system_prompt": "…", "html": "…" }
  ```
- 生成用の指示書は `src/prompts/build.js`、改訂用は `src/prompts/revise.js` に分けて置く（教員が後から書き換える場所）。
- 指示書に必ず入れる内容：
  - 学習者の学習目標・フロー・計画（ステージ1〜4の結果）に沿った学習支援アプリにすること。
  - `system_prompt` は、**学習者の代わりに考えたり答えを出したりせず**、問いかけ・ヒント・確認によって学習者自身に考えさせる方針で書くこと。
  - ガイドブックの全文はアプリに入れないこと（必要な概念だけを system_prompt に要約して入れる）。
  - 次の「生成アプリの決まり」を守ること。
- 改訂では、現在の版の `system_prompt` と `html`、学習者の指示を渡し、変更が必要な部分だけを直した完全な JSON を返させる。

**生成アプリの決まり（指示書に含め、保存時にも検査する）**
1. 1つの HTML ファイルで完結させる。外部の CDN・フォント・画像・スクリプトを読み込まない。
2. AI の呼び出しは次の形だけを使う：
   ```js
   const res = await fetch('/api/run/' + window.LMS_APP.slug, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ input, history })   // history: [{role:'user'|'model', text}]
   });
   const { text } = await res.json();
   ```
   `window.LMS_APP` はサーバが配信時に差し込むので、HTML 側で定義しない。
3. API キーやシステムプロンプトを HTML に書かない。
4. AI の応答は `textContent` で表示し、`white-space: pre-wrap` で改行を保つ（`innerHTML` に AI の応答を入れない）。
5. ブラウザ保存を使う場合は、キー名を `lms_app_<slug>_` で始める。
6. 日本語の画面で、スマートフォンでも使えるレイアウトにする。

**保存時の検査**（`src/validate.js`）
- `html` に `/api/run/` が含まれていること。
- 次のいずれかを含んでいたら不合格：`generativelanguage.googleapis.com`、`api.openai.com`、`AIza` で始まる英数字列、`src="http`、`href="http`（スタイルシート）、`@import url(http`。
- `html` は 500KB 以下、`system_prompt` は 20,000字以下。
- 不合格なら、理由を添えて Gemini に1回だけ作り直させる。それでも不合格なら保存せずにエラーを返す。

### 4-4. 独立アプリの配信と実行

**`GET /a/<slug>`**
- 現在の版の HTML の `<head>` 直後に `<script>window.LMS_APP={slug:"<slug>"};</script>` を差し込んで返す。
- 応答ヘッダ：
  ```
  Content-Type: text/html; charset=utf-8
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'self'
  X-Content-Type-Options: nosniff
  ```

**`POST /api/run/:slug`**
- 入力は4,000字まで、`history` は直近20件まで（超えた分は切り捨て）。
- D1 から現在の版の `system_prompt` を読み、`systemInstruction` として Gemini（`GEMINI_MODEL_RUN`）に渡す。
- 応答は `{ text }` で返す。Gemini のエラーは学習者向けの日本語メッセージに変える。
- `runs` テーブルに記録する（4-5）。

### 4-5. データベース（D1、バインディング名 `DB`）

テーブルは Worker が最初のリクエスト時に `CREATE TABLE IF NOT EXISTS` で作る（マイグレーション手順を不要にするため）。

```sql
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,            -- crypto.randomUUID()
  slug TEXT UNIQUE NOT NULL,      -- 英小文字と数字8文字のランダム
  title TEXT NOT NULL,
  description TEXT,
  goal_json TEXT,                 -- ステージ1の結果
  flow_json TEXT,                 -- ステージ2〜3の結果
  plan_md TEXT,                   -- ステージ4の結果
  current_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_versions (
  app_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  system_prompt TEXT NOT NULL,
  html TEXT NOT NULL,
  instruction TEXT,               -- 改訂の指示（版1は NULL）
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, version)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  input_chars INTEGER,
  output_chars INTEGER,
  latency_ms INTEGER,
  ok INTEGER NOT NULL,
  input_text TEXT,                -- LOG_CONTENT="true" のときだけ
  output_text TEXT                -- 同上
);
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,              -- JST の YYYY-MM-DD
  kind TEXT NOT NULL,             -- 'generate' | 'run'
  count INTEGER NOT NULL,
  PRIMARY KEY (day, kind)
);
CREATE TABLE IF NOT EXISTS login_attempts (
  ts TEXT NOT NULL,
  ok INTEGER NOT NULL
);
```

CSV（`/api/logs.csv`）の列：`created_at, app_title, app_slug, version, input_chars, output_chars, latency_ms, ok`（`LOG_CONTENT="true"` のときは `input_text, output_text` も）。Excel で文字化けしないよう UTF-8（BOM付き）で出す。

## 5. ファイル構成

```
lms-guiding-ai/
├─ wrangler.jsonc          # name, main, assets(run_worker_first: true), d1_databases(DB), vars, observability
├─ package.json            # scripts: dev / deploy、engines.node >=22
├─ .dev.vars.example       # GEMINI_API_KEY / APP_PASSWORD / OWNER_EMAIL の3行だけ
├─ .gitignore              # .dev.vars, .env, node_modules, .wrangler
├─ .gitattributes
├─ README.md               # 5-1 参照
├─ AGENTS.md / CLAUDE.md   # template_triz2026 と同じ方針のルールファイル
├─ src/
│  ├─ index.js             # ルーティング
│  ├─ auth.js              # ログイン・Cookie・Access照合
│  ├─ db.js                # テーブル作成と読み書き
│  ├─ gemini.js            # Gemini 呼び出し
│  ├─ generate.js          # 生成・改訂の流れ
│  ├─ validate.js          # 保存時の検査
│  ├─ limits.js            # 1日の上限
│  └─ prompts/
│     ├─ build.js          # 生成用の指示書（教員が編集）
│     └─ revise.js         # 改訂用の指示書（教員が編集）
├─ public/
│  ├─ login.html
│  ├─ index.html           # LMS画面
│  ├─ app.js
│  └─ style.css
├─ content/
│  ├─ course.json          # 科目名・ステージ1の選択肢など（科目ごとに差し替え）
│  └─ guidebook.md         # ガイドブック本文（画面での説明とダウンロード用）
└─ reference/
   └─ guiding-ai_V3.html   # 移植元の既存ガイディングAI（最終版。教員が置く。デプロイ対象外）
```

### 5-1. 配布（Deploy to Cloudflare ボタン）について
- Deploy to Cloudflare ボタンの公式ドキュメント（https://developers.cloudflare.com/workers/platform/deploy-buttons/ ）を確認し、ボタンから D1 が自動作成される `wrangler.jsonc` の書き方にすること。
- `.dev.vars.example` の各行にはコメントで説明を付ける。ボタンは、コメントになっていない行をすべて「入力必須の Secret」として聞いてくるので、3行以外は書かない。
- README に書くこと：
  1. Deploy to Cloudflare ボタン
  2. 3つの Secret の意味と入れる値
  3. Cloudflare Access の有効化手順（Workers & Pages → 自分の Worker → 設定 → ドメインとルート → workers.dev とプレビューURLで Access を有効化 → 許可するメールアドレスに自分を登録、ログイン方法はワンタイムPIN）
  4. パスワードの変え方（ダッシュボードで `APP_PASSWORD` を更新）
  5. `GEMINI_MODEL_BUILD` を差し替える方法
  6. 注意：API キーをリポジトリやファイルに書かない

## 6. 実装の順序（フェーズごとに止めて確認する）

| フェーズ | 内容 | 終わりの確認 |
|---|---|---|
| 1 | 土台：ファイル構成、ルーティング、D1のテーブル自動作成、ログイン、Access照合 | `npx wrangler dev` で、誤ったパスワードは拒否、正しいパスワードでLMS画面（中身は仮）が出る |
| 2 | ステージ1〜4の移植、`content/` の読み込み | 既存ドラフトと同じ操作でステージ4まで進める |
| 3 | 生成・検査・ライブラリ・独立実行・改訂・版の履歴 | アプリを1つ生成 → プレビューと独立URLで会話できる → 作り直しで版2ができる → 版1に戻せる |
| 4 | 使用状況、上限、CSV、HTML書き出し | 上限を `1` にして 429 が出る、CSV が Excel で開ける |
| 5 | 配布用の仕上げ：`.dev.vars.example`、README、Deploy ボタン | 教員が別アカウントでボタンを押し、最後まで動く |

## 7. 受け入れ基準

1. パスワードなしでは、`/`、`/a/<slug>`、すべての API に入れない。
2. Access を有効にし、`OWNER_EMAIL` と違うメールで入ると 403 になる。
3. ステージ1〜4は既存ドラフトと同じ見た目・操作で動く。
4. 生成したアプリが LMS 内のプレビューと独立URLの両方で動き、AI と会話できる。
5. 生成アプリの HTML（書き出したファイルを含む）に、API キーもシステムプロンプトも含まれない。
6. 生成アプリから外部サイトへの通信は、CSP によって失敗する。
7. 検査に不合格の HTML は保存されない（`AIza…` を含む HTML を手で渡して確認）。
8. 1日の上限を超えると、日本語のメッセージとともに止まる。
9. 別の Cloudflare アカウントで Deploy ボタンを押すと、D1 が作られ、3つの Secret を聞かれ、そのまま動く。
10. リポジトリに API キー・パスワード・個人のメールアドレスが含まれていない。

## 8. 今回は作らないもの

- 複数ユーザー、ユーザー登録
- 学習フローのノード編集（手動設計）
- 受講者をまたいだダッシュボード
- HubSpot・LINE・Trello などのコネクタ
- OpenAI API への切り替え
