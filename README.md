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

## GameDay の流れ(6 フェーズ)

### フェーズ1: 環境構築 & ベースライン確認

```bash
npm run deploy                 # cdk deploy --all
#    出力 GameDay.TargetAppAlbUrl をブラウザで開いて正常 (200) を確認

# ★ 注入前ベースライン (振り返りの説得力の土台):
npm run drift                  # cdk drift が "No drift detected" であること
#    → 出ていたら先に解消するか「既存ドリフト」として記録。
#      こうしておくと実験後のドリフトを "実験(や参加者の対応)起因" と断定できる。
aws synthetics get-canary --name gameday-top --query "Canary.Status.State"  # RUNNING を確認
#    canary 成功率が直近 100% (定常状態) であることが MTTR 算出の起点になる

# (別ターミナル) 当日ダッシュボード — スコア表 / 検知・復旧チャート / KPT
#    dashboard/public/data/gameday.json の編集で画面に即時反映
npm run dashboard
```

### フェーズ2: シナリオ生成(Claude Code)

Claude Code で `add-scenario` スキル(+ `gameday-scenario` エージェント)を使い、
`scenarios/NN-<slug>.md` を生成 → `fis-experiment` スキルで `lib/constructs/fault-injection.ts` に実装。
生成後は必ず `npm run build && npm test && npm run synth:nag` で検証する(詳細は CLAUDE.md / 各スキル)。

### フェーズ3: 障害注入(FIS 実行)

```bash
#    シナリオ1: Fargate タスクを1つ停止 (出力 GameDay.FaultInjectionStopTaskTemplateId)
aws fis start-experiment --experiment-template-id <StopTaskTemplateId>
#    シナリオ2: Aurora をフェイルオーバー (出力 GameDay.FaultInjectionFailoverDbTemplateId)
aws fis start-experiment --experiment-template-id <FailoverDbTemplateId>
aws fis get-experiment --id <experiment-id>   # 状態・タイムライン
#    実験ログは CloudWatch Logs /gameday/fis-experiments に残る (振り返りの素材)
```

### フェーズ4: 復旧対応(参加者)

**参加者向けルール** — 復旧の直し方は**自由**。この選択の差が振り返りで可視化されるのが今回の肝:

- **A. コンソール / CLI で直接直す** — 速いが `cdk drift` に痕跡(応急処置)が残る
- **B. CDK を修正して `cdk deploy`** — IaC 整合を保つが手間がかかる

どちらを選んでもよい。運営はどちらを選んだか(と所要時間)を記録する。

**復旧判定** — canary `gameday-top` が **3 回連続(≒ 3 分)成功**したら「復旧」とみなす。
ダッシュボードの成功率グラフが赤→緑に戻った時刻が復旧時刻 = MTTR の終点。

### フェーズ5: 振り返り(AI 講評)

```bash
# 収集: drift / canary メトリクス / FIS タイムライン / CDK コードの git diff を 1 つに束ねる
bash scripts/collect-retrospective.sh <experiment-id> > retro-data.md
```

`retro-data.md` を Claude Code に渡し、`gameday-retrospective` スキルで 3 視点(canary / drift /
メトリクス = 復旧時間 / IaC 整合性 / 対応の妥当性)を講評 → `retrospectives/` に Markdown レポート。

### フェーズ6: リセット(次のラウンド / 撤収)

```bash
# 前チェック: 実験が停止していること (running が無いこと)
aws fis list-experiments --query "experiments[?state.status=='running'].id"   # 空であること

# 手動対応 (フェーズ4-A) で付いたドリフトをコードの状態へ revert する。
# CloudFormation のドリフト検出を使い "現実 → 期待状態" に戻す change set を作る。
npx cdk deploy --revert-drift   # 新しめの CDK CLI が必要 (この環境の 2.1126.0 で確認済み)
npm run drift                   # 再度 "No drift detected" を確認 = リセット完了

# 完全撤収 (課金停止)
npm run destroy                 # cdk destroy --all
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
