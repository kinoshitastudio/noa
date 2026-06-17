# Noa

iPhone やリモートデバイスから [Claude Code](https://claude.com/claude-code) を操作するための、ブラウザベースのターミナルです。

3カラムレイアウトで、ターミナル・エディター・ファイルツリーを一画面に。

```
TERM  │  EDITOR  │  FILES + PREVIEW
```

---

## 必要なもの

Noa は **macOS** で動きます（Linux もおおむね動作・Windows 非対応）。

- **Node.js 18 以上** — [nodejs.org](https://nodejs.org/ja/)
- **Xcode Command Line Tools** — `node-pty` のビルドに必要（無いと `npm install` が失敗します）。一度だけ実行：
  ```bash
  xcode-select --install
  ```
- **Claude Code** — *Noa の中で Claude を使う場合のみ。* Noa はプロジェクトを開くと `claude` を自動起動するので、先に入れてログインしておきます（未導入だと `command not found: claude` になります）：
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude   # 一度実行するとブラウザが開いてログインできます（Claude の Pro/Max プラン or API キーが必要）
  ```
  詳細：[claude.com/claude-code](https://claude.com/claude-code)

---

## クイックスタート

```bash
npx @kinoshitastudio/noa
```

自動でブラウザが開きます。初回起動時にトークンが生成され、カレントディレクトリの `.noa-env` に保存されます。

またはリポジトリをクローンして起動：

```bash
git clone https://github.com/kinoshitastudio/noa.git
cd noa
npm install
npm start
```

---

## iPhone / iPad からアクセスする

同じ Wi-Fi ネットワーク上の Safari で開く：

```
http://<MacのIPアドレス>:2797/?token=<トークン>
```

Mac の IP アドレスは **システム設定 → Wi-Fi → 詳細 → IP アドレス** で確認できます。

トークンは Noa を起動したディレクトリの `.noa-env` に記載されています。

自宅ネットワーク外からアクセスする場合、Noa は自動で [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) を起動します。起動時のログに URL が表示されます。

---

## Claude Code 連携

PostToolUse フックを使って、Claude Code のタスクリストをリアルタイムで Noa に表示できます。

**1. フックファイルを作成：**

```bash
mkdir -p ~/.claude/noa-hooks
```

`~/.claude/noa-hooks/todo-notify.js` として以下を保存：

```js
#!/usr/bin/env node
'use strict';
const http = require('http');
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(Buffer.concat(chunks));
    const todos = d.tool_input?.todos || [];
    if (!Array.isArray(todos)) return;
    const cwd = process.cwd();
    const project = cwd.split('/').filter(Boolean).pop() || 'default';
    const body = JSON.stringify({ todos, project, path: cwd });
    const token = process.env.NOA_TOKEN || '';
    const port  = process.env.NOA_PORT  || '2797';
    const req = http.request({
      hostname: 'localhost', port,
      path: `/noa-todos?token=${encodeURIComponent(token)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => res.resume());
    req.on('error', () => {});
    req.write(body); req.end();
  } catch {}
});
```

**2. `~/.claude/settings.json` に追記：**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "TodoWrite",
        "hooks": [
          {
            "type": "command",
            "command": "NOA_TOKEN=<your-token> node ~/.claude/noa-hooks/todo-notify.js"
          }
        ]
      }
    ]
  }
}
```

`<your-token>` を `.noa-env` に記載されているトークンに置き換えてください。

設定後、Claude Code がタスクを更新するたびに Noa の **⬡ パネル** にリアルタイム反映されます。

---

## プロジェクト管理

プロジェクトごとに独立した Claude セッションを持てます。

**プロジェクトを登録する：** ファイルツリーのフォルダを右クリック → **⬡ プロジェクト登録**

登録すると ⬡ パネルにタブが追加されます。タブをクリックすると：
- そのプロジェクト専用の Claude セッションにターミナルが切り替わる
- 初回は自動でプロジェクトディレクトリに `cd` して `claude` を起動
- 再度クリックすると既存の会話を再開（セッションは消えない）

タブ横の **×** でプロジェクトを削除できます。

---

## モバイルキーボード

iPhone / iPad では **Game Boy テーマ** にするとフローティング十字キーが表示されます：

- **十字キー** — 矢印キー（長押しでリピート入力）
- **A** — Enter
- **B** — Escape
- **サブキー** — ESC / ^C / TAB / ^L / | / ~
- **📷** — 写真やファイルを選択して `@パス` を自動入力

テーマの切り替えは **設定（⚙）→ GAME BOY**。

---

## 機能一覧

| 機能 | 説明 |
|---|---|
| **ターミナル** | xterm.js、フルカラー、リサイズ対応、スクロールバック |
| **エディター** | Monaco、言語自動検出、シンタックスハイライト |
| **ファイルツリー** | 編集リアルタイムハイライト、右クリックでリネーム・削除・復元 |
| **プレビュー** | ローカルサーバーをパネル内 iframe で表示 |
| **⬡ タスクパネル** | プロジェクト別 Claude Code タスクリスト、リアルタイム更新 |
| **プロジェクトセッション** | プロジェクトタブごとに独立した Claude 会話 |
| **Git ステータス** | ブランチ名とダーティファイル数をステータスバーに表示 |
| **音声入力** | マイク波形表示、3.5秒無音で自動停止 |
| **ファイルドロップ** | ドロップで `~/.noa_uploads/` に保存 → `@パス` を自動入力 |
| **テーマ** | dark · light · Game Boy · OP-1 |
| **Cloudflare Tunnel** | 自動起動、外出先からのアクセスに対応 |

---

## テーマ

| テーマ | スタイル |
|---|---|
| **dark** | デフォルトのダーク |
| **light** | クリーンなホワイト |
| **Game Boy** | DMG グリーン LCD、VT323 ピクセルフォント、モバイル十字キー付き |
| **OP-1** | Teenage Engineering クリーム色 + Liquid Glass 設定パネル |

ヘッダーの **◑** ボタンでサイクル切り替え、または **設定 → テーマ** で直接選択。

---

## キーボードショートカット

| キー | 操作 |
|---|---|
| `⌘S`（エディター内） | ファイルを保存 |
| `⌘M` | マイクのオン/オフ |
| `⌘B` | 設定パネルを開閉 |
| `⌘⇧F` | エディター全画面 |
| `⌘Z` | ファイルのリネーム・削除を元に戻す |
| `≡` ボタン | タスク履歴パネルを開閉 |

---

## セキュリティ

- 全エンドポイントと WebSocket 接続をトークンで認証
- ファイルツリーは起動ディレクトリ（`NOA_ROOT`）内に限定
- パストラバーサルはサーバー側でブロック
- ポート 2797 を追加のセキュリティ対策なしにインターネットに公開しないこと

カスタムトークンを使う場合：

```bash
NOA_TOKEN=yourtoken npm start
```

ファイルアクセスを特定ディレクトリに限定する場合：

```bash
NOA_ROOT=/path/to/project npm start
```

---

## ライセンス

MIT — [kinoshita studio](https://kinoshita.studio)
