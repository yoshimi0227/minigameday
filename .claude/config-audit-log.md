# Claude 設定監査ログ

## 2026-07-18(範囲限定: CLAUDE.md「よく使うコマンド」セクション)

### 参照ソース
- https://code.claude.com/docs/en/memory.md — Consistency(陳腐化した指示の除去)、`@package.json` import の選択肢
- https://code.claude.com/docs/en/best-practices.md — CLAUDE.md の ✅/❌ 表(「Claude が推測できない Bash コマンドは載せる」「頻繁に変わる情報は載せない」)
- 突き合わせ対象: package.json の scripts / bin/minigameday.ts(2 スタック構成)/ cdk.json
- CHANGELOG は範囲外のため未確認(全体監査時に実施すること)

### 適用した変更(全項目ユーザー承認済み)
- 🔴 `npx cdk deploy` → `npm run deploy`(= `cdk deploy --all`)。2 スタック構成 (GameDay + GameDay-Legacy) ではスタック指定なしの deploy が失敗するため。synth / diff / drift も npm スクリプトに統一(package.json を単一の情報源に)
- 🟡 `npm run build` の注釈を実態 (`tsc && tsc -p dashboard`) に合わせ修正。`lint:fix` の言及と `npm run destroy`(都度確認)を追記
- 🟢 `aws fis stop-experiment --id <id>`(緊急停止)を追記

### 見送った項目
- `@package.json` import への置き換え — 日本語注釈(「ポーリング込み」等)は Claude が推測できない情報のため、注釈付きリストの維持を優先
- `watch` / `test:watch` / `dashboard:build` の掲載 — 対話用・低頻度のため不掲載のままとする判断で一致
