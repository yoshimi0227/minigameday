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
| └ `ScoreEscalation` | スコア置き場(DynamoDB)+ Streams 起動 Lambda。実効スコアが閾値到達で「次の障害」を自動発火 |
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

**障害開始を遅らせる**: デプロイ時に `-c faultDelayMinutes=5` を渡すと、各実験の先頭に
`aws:fis:wait` (5 分) が入る。`start-experiment` を叩くと実験は「実行中(待機)」になり、
**5 分後に障害が発生**する (デプロイ直後に叩けば実質デプロイ+5分)。待機は障害の前なので
停止条件は誤発火しない。0/未指定なら即時 (既定)。

```bash
npx cdk deploy GameDay -c faultDelayMinutes=5   # 開始 5 分後に障害
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

## スコア到達で「次の障害」を自動発火 (エスカレーション)

参加者の実効スコア(獲得 − ヒント消費)が閾値に達すると、**次の障害 (Aurora フェイルオーバー) を
自動で発火**する仕組み。「うまく対応できたら難易度が上がる」エスカレーション演出。実装は
`lib/constructs/score-escalation.ts` + `lambda/score-escalator/index.mjs`。スコアはゲーム状態なので
CloudWatch メトリクスではなく **DynamoDB** に持ち、そこから先はイベント駆動で AWS 側に閉じる:

```
ダッシュボード (実効スコアを計算)
   │ POST /api/score   ← dev サーバ (vite.config.ts) が DynamoDB に put-item
   ▼
DynamoDB gameday-score { pk:'SCORE', total:N }
   │ DynamoDB Streams (NEW_IMAGE, pk=SCORE の INSERT/MODIFY だけに絞る)
   ▼
Lambda score-escalator (閾値判定 → FIRED#id を条件付き put で冪等クレーム)
   ▼
fis:StartExperiment  → 次の障害が自動発火 (1 回だけ)
```

- **閾値の変更**: `-c escalateAtScore=150`(既定 100)。到達スコアで発火する。
- **冪等性**: 各トリガーは `FIRED#<id>` アイテムの条件付き書き込みで「先勝ち」クレームし、1 回だけ発火。
- **運用上の前提**: スコア同期 (dev サーバ → DynamoDB) は **AWS 認証済みシェルで `npm run dashboard`
  を起動している**こと(既定クレデンシャルチェーンを使う)。未認証・スタック未デプロイでも
  ダッシュボードの表示は壊れない(同期はベストエフォート)。テーブル名は既定 `gameday-score`
  (別名にするなら `GAMEDAY_SCORE_TABLE` env で dev サーバ側と CDK 側を合わせる)。
- **発火の確認**: `aws fis list-experiments` に escalation 由来の実験(タグ `TriggeredBy=score-escalator`)が
  現れる。Lambda ログは CloudWatch Logs のエスカレーター用ロググループ。

```bash
npx cdk deploy GameDay -c escalateAtScore=150   # スコア 150 到達で次の障害
```

## Slack 通知 (障害発生・復旧)

canary の成功率を監視する CloudWatch アラーム (`gameday-canary-health`) の状態遷移を
SNS → AWS Chatbot 経由で Slack に流す。**成功率が 100% を下回る = 🔴 障害発生 (ALARM)**、
**100% に戻る = 🟢 復旧 (OK)**。1 つのアラームで発生・復旧の両方を通知する
(自己回復型でユーザー影響が出ないシナリオは鳴らない)。実装は `lib/constructs/slack-notify.ts`。

**初回だけ手作業が必要** (Slack ワークスペースの認可):

1. AWS コンソールで **Amazon Q Developer in chat applications** (旧 AWS Chatbot) を開く。
2. Slack クライアントを設定し、対象ワークスペースを認可する (OAuth)。
3. 認可後にコンソールに表示される **ワークスペース ID** を控える。

その ID を context で渡してデプロイすると Slack 連携が有効になる:

```bash
npx cdk deploy GameDay \
  -c slackWorkspaceId=<ワークスペースID> \
  -c slackChannelId=<チャンネルID>
```

- context を渡さない場合は SNS までを作り Slack 連携はスキップする (他環境でも deploy 可)。
- 起動直後に監視が有効化される際、INSUFFICIENT_DATA → OK の遷移で「正常」通知が 1 度出る
  (= GameDay の監視が稼働した合図)。以降は 🔴 障害 / 🟢 復旧 のみ。
- ワークスペース/チャンネル ID を毎回打ちたくなければ、gitignore 済みの
  `cdk.context.json` に入れておくとよい (公開リポジトリには commit されない)。

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
