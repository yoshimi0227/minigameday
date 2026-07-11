---
name: gameday-retrospective
description: GameDay / FIS 実験の振り返りを行う。「振り返りして」「実験の結果をまとめて」「障害の影響を見せて」「ドリフト検出して」「レポートを作って」など、実験の前後比較・影響分析・振り返りレポート作成の全てで必ず使う。実験の「前」から使うスキルであることに注意 — ベースライン取得 (実験前) → 観測 (実験中) → 3 視点分析と retrospectives/ へのレポート保存 (実験後) までを一連で扱う。cdk drift / CloudFormation ドリフト検出、Synthetics canary の結果確認、CloudWatch メトリクスの前後比較が絡む作業も該当する。
---

# GameDay 振り返り

FIS 実験の前後を突き合わせて「何が起き、どう見え、何を学んだか」を `retrospectives/` に残すスキル。
実験の成否そのものより「仮説と観測のズレ」が学びになる。ズレを見つけるには実験前のベースラインが必須なので、このスキルは実験後ではなく**実験前から**使う。

## 3 つの視点

| 視点 | 何が分かるか | 主なソース |
|---|---|---|
| 外形監視 (Synthetics) | ユーザーから見えた影響 | `SuccessPercent` / `Duration` メトリクス、スクリーンショット、失敗 run のログ |
| ドリフト (cdk drift) | 実験中に人間や自動化がインフラに施した「応急処置」の痕跡 | `cdk drift` / CloudFormation ドリフト検出 |
| メトリクス (CloudWatch) | システム内部で起きたこと | ALB `HTTPCode_ELB_5XX_Count` / `TargetResponseTime`、ECS `RunningTaskCount` / `CPUUtilization`、RDS `DatabaseConnections` |

加えて **CDK コードの `git diff`** も素材にする — 参加者が「コンソールで直した」(→ drift に出る) のか「CDK を修正して deploy した」(→ git diff に出る) のかで、対応の質 (IaC 整合性) が分かる。

**データ収集は 1 コマンドで束ねられる**: `bash scripts/collect-retrospective.sh <experiment-id> [canary] [stack]` が FIS タイムライン / canary 成功率 / cdk drift / git diff を 1 つの Markdown に出す。これを入力に講評する。

背骨は FIS 実験のタイムライン (`aws fis get-experiment`)。全ての観測は実験の開始・終了時刻に対して「前・中・後」で並べる。

**ドリフトの読み方 (このプロジェクトの核心)**: stop-task のような自己完結型の障害は ECS が自己修復するので、ドリフトが残らないのが正常。ドリフトが検出されたら、それは (a) GameDay 中の手動対応 (desiredCount 変更、セキュリティグループ編集など) の痕跡か、(b) 実験前から存在した管理外変更のどちらか。実験前に drift をクリーンにしておくのは、この切り分けを可能にするため。検出された手動対応は「IaC に反映すべきか、次回は自動化すべきか」まで踏み込んで記録する。

## フェーズ

### 実験前 (ベースライン)

1. `npx cdk drift` を実行し、クリーンであることを確認する(実験後のドリフトを実験起因と断定できるように)。クリーンでなければ先に解消するか、既存ドリフトとして記録しておく。
2. canary の直近の成功率・Duration を記録する。
3. 主要メトリクス (上の表) の直近値を記録する。
4. [assets/retrospective-template.md](assets/retrospective-template.md) をコピーして `retrospectives/YYYY-MM-DD-<シナリオID>.md` を作り、「実験前」の欄を埋める。

### 実験中

- `aws fis get-experiment --id <id>` で実験の状態を追う。
- canary と停止条件アラームの状態を観測する。「いつ・何で異常に気づいたか」をメモする — 振り返りの「検知までの時間」の材料になる。

### 実験後

1. **タイムライン確定**: `get-experiment` から各アクションの開始・終了・最終状態を転記する。停止条件で強制停止された場合はその時刻と発火したアラームも。
2. **外形監視の差分**: `SuccessPercent` / `Duration` を前・中・後で取得。失敗した run はスクリーンショットとログまで見る (`aws synthetics get-canary-runs`)。「最初のユーザー影響」と「回復」の時刻を特定する。
3. **ドリフト検出**: `npx cdk drift` を実行。差分があればリソース・プロパティ・変更内容を記録し、手動対応かどうかを参加者に確認する。
4. **メトリクスの差分**: 3 視点の表のメトリクスを前・中・後で比較する。
5. **FIS 実験レポート / 実験ログ**: `experimentReportConfiguration` の PDF (S3) と、`logConfiguration` の実験ログ (CloudWatch Logs `/gameday/fis-experiments`) の場所をレポートに記載する。
6. テンプレートの残りを埋める。**「仮説と観測のズレ」が本体**。合っていたことも違ったことも両方書く。学びとアクションアイテムで締める。

### リセット (次のラウンド前 / 撤収前)

参加者がコンソールで直した (drift が残っている) 場合、次のラウンド前にコードの状態へ戻す。

1. **前チェック**: 実験が停止していること。`aws fis list-experiments --query "experiments[?state.status=='running'].id"` が空。
2. **revert**: `npx cdk deploy --revert-drift` — ドリフトを検出し「現実 → 期待状態 (コード)」へ戻す change set を作る (新しめの CDK CLI が必要)。
3. **確認**: `npx cdk drift` が再び "No drift detected" になればリセット完了。
4. 撤収なら `npm run destroy`。

## コマンドレシピ

```bash
# 実験の状態・タイムライン
aws fis list-experiments
aws fis get-experiment --id <experiment-id>

# canary の実行履歴 (成否・失敗理由・アーティファクトの場所)
aws synthetics get-canary --name <canary-name>
aws synthetics get-canary-runs --name <canary-name>

# canary 成功率の時系列 (実験前後を 1 分粒度で)
aws cloudwatch get-metric-statistics \
  --namespace CloudWatchSynthetics --metric-name SuccessPercent \
  --dimensions Name=CanaryName,Value=<canary-name> \
  --start-time <ISO8601> --end-time <ISO8601> --period 60 --statistics Average

# ドリフト検出 (CDK: 検出開始からポーリング・結果表示まで面倒を見てくれる)
npx cdk drift

# ドリフト検出 (CLI 直。detect は非同期なのでポーリングが要る)
aws cloudformation detect-stack-drift --stack-name <stack-name>
aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id <id>
aws cloudformation describe-stack-resource-drifts --stack-name <stack-name> \
  --stack-resource-drift-status-filters MODIFIED DELETED

# ALB のエラー・レイテンシ (namespace AWS/ApplicationELB, dimensions LoadBalancer=<full-name>)
aws cloudwatch get-metric-statistics --namespace AWS/ApplicationELB \
  --metric-name HTTPCode_ELB_5XX_Count ...
```

注意: `cdk drift` は CloudFormation のドリフト検出を呼ぶ(実リソース vs スタックの期待状態)。`cdk diff` はローカルコード vs デプロイ済みテンプレートの比較で、別物。振り返りで使うのは drift。ドリフト検出に対応していないリソースタイプもあるため、「ドリフトなし」=「変更なし」とは限らない点をレポートにも書く。

## レポートの置き場所と命名

- `retrospectives/YYYY-MM-DD-<シナリオID>.md` (例: `retrospectives/2026-07-15-scenario-01.md`)
- シナリオ (`scenarios/`) とは別ディレクトリにするのは、シナリオ=計画 / 振り返り=記録で、1 シナリオを複数回実施することがあるため。
