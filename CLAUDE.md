# ミニ GameDay (振り返り機能付き)

生成AI × AWS CDK × AWS FIS で「振り返れる」ミニ GameDay をつくるプロジェクト。
CFP 登壇用。3年前の「AWS CDK × AWS FIS でミニ GameDay をつくろう」の 2026 年アップデート版。

## このプロジェクトの 3 本柱

1. **AI でシナリオを考える** — 生成AIに GameDay の障害シナリオ(仮説・注入する障害・期待する振る舞い)を立案させる。
2. **AI で障害実装** — シナリオを AWS FIS の実験テンプレート(CDK)に落とす。
3. **振り返り機能** — `cdk drift` (CloudFormation ドリフト検出) と CloudWatch Synthetics の **Playwright ランタイム** による外形監視で、障害前後の差分・影響を可視化して振り返る。

## 技術スタック

- **言語**: TypeScript
- **IaC**: AWS CDK v2 (`aws-cdk-lib`)
- **対象アプリ (お題)**: ECS / Fargate Web アプリ (ALB + Fargate + RDS 想定の 3 層)
- **障害注入**: AWS FIS (Fault Injection Service) — タスク停止 / ネットワーク遅延など
- **振り返り**: CloudFormation Drift Detection (`cdk drift` / `aws cloudformation detect-stack-drift`)、CloudWatch Synthetics (Playwright ランタイム)
- **ツールチェーン**: Vite+ (`vp`) — テスト・リントを `vite.config.ts` に一元設定
- **テスト**: Vitest (`vp test`) + `aws-cdk-lib/assertions`。テストファイルは `import { test, expect } from 'vitest'` を明示する (globals は使わない)
- **静的チェック**: Oxlint + `oxlint-plugin-awscdk` (`vp lint`) — CDK 固有のアンチパターン検出
- **コンプライアンス検査**: cdk-nag (AwsSolutionsChecks)。`npm run synth:nag` で実行。通常 deploy は速さ優先で無効、意図的な GameDay トレードオフは `lib/nag-suppressions.ts` に理由付きで集約
- **CDK アプリ実行**: `tsx` (cdk.json の `app`)。ts-node は使わない
- **コミット前フック**: lefthook (`lefthook.yml`) が pre-commit で `npm run lint` を走らせる

## 3 本柱とスキル・エージェントの対応

| 柱 | 使うもの | 役割 |
|---|---|---|
| 1. シナリオ立案 | `add-scenario` スキル + `gameday-scenario` エージェント | 追加手順・観測可能性チェック (スキル) と設計本体 (エージェント)。`scenarios/NN-<slug>.md` に保存 |
| 2. 障害実装 | `fis-experiment` スキル | シナリオを `lib/constructs/fault-injection.ts` の FIS 実験テンプレートに実装。安全装置チェックリスト付き |
| 3. 振り返り | `gameday-retrospective` スキル | 実験前ベースライン → 観測 → 3 視点分析 (canary / drift / メトリクス) → `retrospectives/` にレポート |
| (当日運営) | `gameday-dashboard` スキル | スコア表・KPT フィードバックのダッシュボードサイト (`dashboard/`) の運用。`gameday.json` 編集で即時反映 |
| (テスト) | `aws-cdk-unit-testing` スキル (外部プラグイン) | CDK テストの書き方の判断基準 |

シナリオは frontmatter (`id` / `status: draft→implemented→executed` / `fis_actions` / `prerequisites`) 付き markdown。フォーマットの詳細はエージェント定義 (`.claude/agents/gameday-scenario.md`) にある。

### シナリオ生成・実装時の制約(ハルシネーション対策 + 安全)

AI に FIS 実験を書かせるときの必須制約。詳細と実装例は `fis-experiment` スキルにあるが、要点:

- **FIS は L1 (`CfnExperimentTemplate`) で出力する**。`aws-cdk-lib/aws-fis` に L2 は無い。
- **`stopConditions` 必須**(canary/アラームベース)。停止条件の無い実験はデプロイしない。
- **ターゲティングで爆発半径を明示する**。対象の性質で使い分ける:
  - **ephemeral な対象**(ECS タスク等、ARN が実行時にしか決まらない)→ `resourceTags` + `selectionMode` (`COUNT`/`PERCENT`)。同じタグが他リソースに付いていないか確認する。
  - **deploy 時に ARN が確定する安定リソース**(同一スタックの Aurora クラスタ等)→ CDK 参照経由の `resourceArns` で名指しする方が正確(タグの取り違えが起きず、単一リソースに確実に絞れる)。`FaultInjection` の Aurora フェイルオーバーがこのパターン。「タグで縛る」の唯一解ではなく、"deploy 時に確定するなら ARN、実行時に決まるならタグ" が原則。
- **`logConfiguration` (CloudWatch Logs) と `experimentReportConfiguration` を設定**する(振り返りの素材)。
- **アクション仕様は記憶で書かない**。`.claude/skills/fis-experiment/references/fis-actions.md`(検証済みメモ)を読み、無ければ AWS Knowledge MCP / `aws fis list-actions` で確認する。
- **生成物の置き場所**: シナリオ = `scenarios/NN-<slug>.md`(markdown)、実装コード = `lib/constructs/fault-injection.ts`。
- **生成後の検証ループ**: `npm run build`(型)→ `npm test`(fine-grained/スナップショット)→ `npm run synth:nag`(cdk-nag)を通してからデプロイ。「AI に書かせて検証する」を必ず一巡させる。

## ディレクトリ構成 (予定)

```
bin/            CDK アプリのエントリポイント (GamedayStack + GameDay-Legacy)
lib/            スタック・コンストラクト定義
  gameday-stack.ts    本体スタック (3 本柱を 1 スタックに統合。cross-stack 参照ゼロ)
  constructs/
    target-app.ts       対象アプリ 3層 (ALB / Fargate / Aurora Serverless v2)
    observability.ts    Synthetics canary / CloudWatch アラーム・ダッシュボード
    fault-injection.ts  FIS 実験 3 種 (stop-task / failover / scale-to-zero)。faultDelayMinutes は "5-15" 範囲 = synth 時乱数に対応。scale-to-zero は SSM Automation (aws:ssm:start-automation-execution) で desiredCount=0 = 自己回復しない対応ラウンド用
    slack-notify.ts     障害/復旧の Slack 通知 (canary ヘルスアラーム→SNS→AWS Chatbot)
    score-escalation.ts スコア閾値到達で「次の障害」を自動発火 (DynamoDB Streams→Lambda→FIS)
    game-events.ts      自動採点のイベント記録 (アラーム遷移 + FIS 状態遷移→EventBridge→Lambda→DynamoDB)。本体・legacy 両スタックで使う (legacy は gameday-score を名前インポート)
  legacy-app-stack.ts SPOF 出発点スタック (scenario-03。EC2 rebuild + 本番モードの canary-health/GameEvents)。deploy ライフサイクルが異なるので別スタック。GameDay の後にデプロイ (gameday-score 名前依存)
  nag-suppressions.ts cdk-nag の意図的抑制 (理由付き)
lambda/         Lambda ソース (score-escalator / game-events。ESM .mjs、NodejsFunction でバンドル)
app/            対象アプリのソース (DB に ping する Node アプリ + Dockerfile)
scenarios/      AI が生成した GameDay シナリオ (markdown, frontmatter 付き)
retrospectives/ 振り返りレポート (YYYY-MM-DD-<シナリオID>.md)
dashboard/      スコア表・振り返りダッシュボード (React + TypeScript。データは public/data/gameday.json)
canaries/       Synthetics Playwright スクリプト
test/           CDK ユニットテスト
.claude/
  agents/       gameday-scenario エージェント
  skills/       fis-experiment / gameday-retrospective スキル
```

## 規約・進め方

- AWS の最新仕様 (CDK / FIS / Synthetics の新機能) は **AWS Knowledge MCP** または公式ドキュメントで確認してから実装する。記憶に頼らない。FIS・Synthetics は機能追加が速い。
- CDK のテストは `aws-cdk-unit-testing` スキルの判断基準に従う(スナップショット / fine-grained / バリデーションの使い分け)。ただしスキルのコード例は Jest 前提なので、このプロジェクトでは Vitest に読み替える(`expect` API はほぼ互換。`import { test, expect } from 'vitest'` を付ける)。
- コードを書いたら `npm run lint` (Oxlint + awscdk プラグイン) を通す。公開プロパティ・Props はコンストラクト具象型でなくインターフェース型 (`ICluster` 等) で公開する。
- **スタックは分割しない。** 本体は `GamedayStack` 1 つで、関心分離は `lib/constructs/` 配下の Construct 分割で行う (cross-stack Strong Reference を避ける。`aws-cdk-development` スキル鉄則1・2)。deploy ライフサイクルが異なる `GameDay-Legacy` (scenario-03) だけが例外。
- `app/` (対象アプリ) と `canaries/` (canary スクリプト) は**意図的に素の JS のまま**にする (TS 化しない)。実行環境が JS を直接実行し「デプロイ物 = ソース」であることが振り返り・デモで価値になるため (特に Synthetics コンソールはスクリプトをそのまま表示する)。
- **採点・イベント導出ロジックは `dashboard/src/scoring.ts` に集約する** (React 非依存の純関数)。UI (App/Tiles/ScoreTable) と dev サーバ (`dashboard/vite.config.ts` の gameEventsSync) の両方がここを import する。採点の優先順位は `scoreOverride` > 自動採点 (検知/復旧/伝達) > 手動 `score`。gameday.json への書き込みは vite.config.ts の `updateGamedayJson` (直列化キュー) を必ず通す。
- 破壊的操作は GameDay の本旨だが、**対象スタックの外**に影響を出さない。リソースは識別しやすいタグ・命名 (`gameday-*`) を付ける。
- `cdk deploy` は自動許可、`cdk destroy` / `cdk bootstrap` は都度確認。
- コスト注意: Fargate / RDS / NAT Gateway は起動しっぱなしで課金される。GameDay 終了後は `cdk destroy` する前提で組む。FIS の実験レポートも 1 通ごとに課金される。

## 検証済み技術メモ (2026-07-07 時点)

- **Synthetics Playwright ランタイム**: 最新は `syn-nodejs-playwright-7.1` (Node.js 22 / Playwright 1.59)。5.1 以降は namespace が `@aws/synthetics-playwright`(旧 `@amzn/...` は非推奨)。型定義は npm にあり、ランタイムとバージョンを合わせる。
- **CDK の Playwright ランタイム定数**: `synthetics.Runtime.SYNTHETICS_NODEJS_PLAYWRIGHT_*`(aws-cdk-lib 2.258.1 では `6_0` が最新定数)。現在このプロジェクトは 6.0 を使用。定数未提供の新ランタイムは `new synthetics.Runtime('syn-nodejs-playwright-7.1', synthetics.RuntimeFamily.NODEJS)` で指定できる。
- **Vite+ / Oxlint の前提**: ツールチェーンは Node.js >= 22 が必要 (この環境は Node 24.18 / npm 11)。Node が古いと npm が optional 依存のネイティブバイナリを**黙ってスキップ**し「Cannot find native binding」で落ちる。corsa-oxlint (型認識リント) は Windows で JS シムを spawn する不具合があり、`vite.config.ts` の `settings.corsaOxlint.corsa.executable` で `tsgo.exe` を明示している。
- **FIS は L1 のみ**: `aws-cdk-lib/aws-fis` は `CfnExperimentTemplate` だけ。L2 を探さない。アクション仕様の検証メモは `.claude/skills/fis-experiment/references/fis-actions.md`。
- **NodejsFunction のバンドルは CJS 出力にする (2026-07-17 実機で確認)**: `format: ESM` + `externalModules: []` で CJS の AWS SDK を同梱すると Lambda が `Dynamic require of "node:https" is not supported` で Init クラッシュする。定石の createRequire banner は **Windows のローカルバンドルでシェルにダブルクォートを剥がされて SyntaxError** になるため使えない。`OutputFormat.CJS` なら両問題が消える (.mjs ソースのままで可。トップレベル await を使う場合のみ再考)。
- **tags 付き `fis:StartExperiment` には `fis:TagResource` も要る (2026-07-17 実機で確認)**: 開始時タグは新規実験へのタグ付けとして別権限が要求され、無いと AccessDenied。ユニットテストでは捕まらない — 「AI に書かせて実機で一巡」の検証ループを省略しない。
- **FIS でネイティブアクションが無い操作は `aws:ssm:start-automation-execution`**: FIS には ECS の desiredCount 変更や SG ルール削除のネイティブアクションが無い。SSM Automation ドキュメント (`aws:executeAwsApi` ステップ) を FIS から起動する。パラメータ = `documentArn` / `documentParameters` (JSON 文字列) / `maxDuration` (PT1M〜PT12H)。FIS ロール権限 = `ssm:StartAutomationExecution`/`GetAutomationExecution`/`StopAutomationExecution` + `iam:PassRole` (automation ロール)。`documentParameters` にトークン (ARN/名前) を入れるときは `JSON.stringify` ではなく `stack.toJsonString(...)` を使う (トークンを Fn::Join で解決)。scale-to-zero (scenario-05) がこのパターン。
- **`cdk drift` と `cdk diff` は別物**: drift は実リソース vs スタックの期待状態(振り返りで使うのはこっち)、diff はローカルコード vs デプロイ済みテンプレート。
- **AWS 構成図の生成 (ハンドアウト/登壇資料用) は `aws-architecture-diagram` スキル** (Claude Code プラグイン `deploy-on-aws@agent-plugins-for-aws`、user スコープ導入済み 2026-07-15)。AWS4 公式アイコンの draw.io XML を生成し、PostToolUse フックが自動検証、`drawio_url.py` で diagrams.net プレビュー URL を出せる。前提: `python3` + `defusedxml` (導入済み)。PNG/SVG 書き出しは draw.io desktop の CLI を使う。**旧 AWS Diagram MCP (`awslabs.aws-diagram-mcp-server`) は全バージョン yank 済みの非推奨のため使わない** (このスキルが公式後継)。ダッシュボードの構成図は aws-icons による React 描画 (`dashboard/src/Architecture.tsx`) で、プラグインには依存しない — 役割分担: 画面 = React 描画、配布物 = このスキル。

## よく使うコマンド

```bash
npm run build          # tsc 型チェック (CDK 本体 + dashboard)
npm run lint           # Oxlint + awscdk プラグイン (vp lint)。lint:fix で自動修正
npm run synth:nag      # cdk-nag コンプライアンス検査 (AwsSolutionsChecks)
npm test               # ユニットテスト (Vitest / vp test run)
npm run dashboard      # GameDay ダッシュボード (Vite dev、gameday.json 編集で即時反映)
npm run synth          # cdk synth (全スタック)
npm run diff           # cdk diff
npm run deploy         # cdk deploy --all (GameDay → GameDay-Legacy の順)。単体は npx cdk deploy GameDay 等
npm run drift          # cdk drift (振り返り。ポーリング込み)
npm run destroy        # cdk destroy --all (都度確認)
aws fis start-experiment --experiment-template-id <id>      # 障害注入
aws fis get-experiment --id <id>                            # 実験の状態・タイムライン
aws fis stop-experiment --id <id>                           # 実験の緊急停止
```
