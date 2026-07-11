# ミニ GameDay (振り返り機能付き)

生成AI × AWS CDK × AWS FIS で「振り返れる」ミニ GameDay。
ALB + Fargate の Web アプリに FIS で障害を注入し、CloudWatch Synthetics (Playwright ランタイム) と `cdk drift` で振り返る。

## スタック構成

本体は **`GameDay` 1 スタック**。3 本柱は `lib/constructs/` 配下の Construct で分離する(cross-stack Strong Reference を避けるため。詳細は CLAUDE.md)。

| スタック / Construct | 役割 |
|---|---|
| `GameDay` スタック | 下記 3 Construct を束ねる本体スタック |
| └ `TargetApp` | お題の対象アプリ(3層)。ALB + Fargate(DB に ping する Node アプリ ×2)+ Aurora MySQL Serverless v2。`/healthz`=生存、`/`=DB 疎通(200/503) |
| └ `Observability` | 振り返り。Synthetics canary(Playwright)、5xx 停止条件アラーム、ダッシュボード `gameday-review`(ALB/Target/Aurora 指標) |
| └ `FaultInjection` | 障害注入。FIS 実験テンプレート2種(①Fargate タスク停止 / ②Aurora フェイルオーバー) |
| `GameDay-Legacy` スタック | scenario-03 用の SPOF 出発点(単一 EC2)。deploy ライフサイクルが異なるので独立。必要な回だけデプロイ |

## セットアップ

```bash
npm install
npx cdk bootstrap        # 初回のみ (アカウント/リージョンごと)
```

> アプリ層は `app/` を Docker ビルドする(`ContainerImage.fromAsset`)。
> **`cdk deploy` 時は Docker デーモンの起動が必要**(`cdk synth` は不要)。

## GameDay の流れ

```bash
# 1. デプロイ
npm run deploy                 # cdk deploy --all
#    出力の GameDay.TargetAppAlbUrl をブラウザで開いて正常を確認

# (別ターミナル) 当日ダッシュボード — スコア表 / 検知・復旧チャート / KPT を表示。
#    dashboard/public/data/gameday.json の編集で画面に即時反映される
npm run dashboard

# 2. 障害注入 (デプロイ出力のテンプレート ID を使う)
#    シナリオ1: Fargate タスクを1つ停止 (出力 GameDay.FaultInjectionStopTaskTemplateId)
aws fis start-experiment --experiment-template-id <StopTaskTemplateId>
#    シナリオ2: Aurora をフェイルオーバー (出力 GameDay.FaultInjectionFailoverDbTemplateId)
aws fis start-experiment --experiment-template-id <FailoverDbTemplateId>

# 3. 振り返り
#    - CloudWatch ダッシュボード "gameday-review" で canary 成功率 / 5xx / Healthy Host を確認
#    - 構成のドリフトを検出
npm run drift                  # cdk drift
aws cloudformation detect-stack-drift --stack-name GameDay

# 4. 片付け (課金停止)
npm run destroy                # cdk destroy --all
```

## コスト注意

Fargate / ALB / NAT Gateway は起動中ずっと課金される。GameDay が終わったら必ず `npm run destroy`。

## 開発

```bash
npm run build      # tsc 型チェック (CDK + dashboard)
npm run lint       # Oxlint + awscdk プラグイン (CDK の静的チェック)
npm test           # ユニットテスト (FIS/Synthetics の要点 + dashboard の描画を守る)
npm run synth      # 合成 (env 非固定なのでオフラインで通る)
npm run diff       # 差分
npm run dashboard  # GameDay ダッシュボード (React。dashboard:build で静的ビルド)
```

シナリオ立案は Claude Code のサブエージェント `gameday-scenario` を使う。
