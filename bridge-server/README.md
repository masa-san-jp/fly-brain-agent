# fly-brain bridge-server

ローカルのブラウザと Ollama / Claude Code / Codex を WebSocket でつなぐ中継サーバです。ブラウザから外部コマンドを直接実行せず、`127.0.0.1` にだけバインドします。

## 起動

```sh
cd bridge-server
npm install
npm start
```

既定ポートは `8787` です。`PORT=9000 npm start` または `npm start -- --port 9000` で変更できます。全バックエンドを決定論的なモックにする場合は次を使います。

```sh
npm run mock
```

クライアントは `ws://127.0.0.1:8787` に接続し、Origin は `http://localhost:<port>` または `http://127.0.0.1:<port>` にしてください。イベントの `state.pos` は `[x, y, z]` の3要素です。

## 手動での Claude Code / Codex 呼び出し

サーバを起動せず、専用ワークスペースでプロンプトを確認するだけの最小例です。実際のサーバも同じ安全側の引数で起動します。

```sh
cd bridge-server/workspace
claude -p 'JSONで短い日本語の一言を返す' --output-format text --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands --no-session-persistence
codex exec --sandbox read-only -C "$PWD" --skip-git-repo-check 'JSONで短い日本語の一言を返す'
```

## 安全策

- Origin は localhost / 127.0.0.1 の HTTP(S) だけを受け付けます。サーバは 127.0.0.1 にのみ bind します。
- 入力はイベントの whitelist schema で検証し、未知のキーを除去してから固定テンプレートと JSON だけをプロンプトにします。
- Claude Code は `--tools ""`（全ツール無効）に加え、`--setting-sources ""`・`--strict-mcp-config`・`--disable-slash-commands`・`--no-session-persistence` で、オーナーの設定・CLAUDE.md・MCP・スキル・セッション履歴を読み込ませません。子プロセスに渡す環境変数は PATH・HOME・USER・LOGNAME だけです（USER はキーチェーンのログイン情報の参照に必要）。Codex は `--sandbox read-only` と専用 `workspace/` を使います。権限確認を省略するフラグは使いません。
- Claude Code / Codex は同時に1プロセスだけ、60秒で SIGTERM、その後 SIGKILL です。
- Ollama はローカル HTTP の JSON モード、既定モデル `gemma4:e4b`、30秒タイムアウトです。
- レート制限は Ollama が毎分30回、Claude Code / Codex が毎分2回です。設定から変更できます。
- 子プロセスには `PATH` と `HOME` だけを渡し、親プロセスの環境全体や秘密を渡しません。呼び出しログにも秘密を出さないようにします。
- ログは `logs/calls.jsonl` に保存されます。`workspace/` の実行時ファイルとログは Git 管理対象外です。

## テストと Ollama スモークテスト

```sh
npm test
node scripts/smoke-ollama.mjs
```

スモークテストは既存の Ollama に接続し、なければ `ollama serve` を起動して `touched_agent` を1回送信します。テスト終了時には、このスクリプト自身が起動した Ollama だけを停止します。
