# FIS アクション検証メモ (ALB + Fargate + Aurora の 3 層構成向け)

**検証日: 2026-07-07** (AWS Knowledge MCP / 公式ドキュメントで確認)。
FIS は機能追加が速い。実装時にパラメータ名や権限が疑わしければ、このメモを盲信せず
[FIS Actions reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html) を再確認し、変わっていたらこのメモを更新すること。

## ECS アクション一覧

- `aws:ecs:drain-container-instances` (EC2 起動タイプ向け。Fargate では使わない)
- `aws:ecs:stop-task`
- `aws:ecs:task-cpu-stress`
- `aws:ecs:task-io-stress`
- `aws:ecs:task-kill-process`
- `aws:ecs:task-network-blackhole-port`
- `aws:ecs:task-network-latency`
- `aws:ecs:task-network-packet-loss`

### aws:ecs:stop-task — 追加インフラ不要。最初の GameDay に最適

コントロールプレーン操作なのでサイドカー等の仕込みが不要。

- ターゲット: `aws:ecs:task`。`parameters` で `cluster` / `service` を指定して絞れる
- 実験ロール権限: `ecs:DescribeTasks`, `ecs:ListTasks`, `ecs:StopTask`, `tag:GetResources`(マネージドポリシー `AWSFaultInjectionSimulatorECSAccess` でも可だが広い)

### aws:ecs:task-* (stress / latency / packet-loss / kill-process) — SSM サイドカーが前提

タスク内部で faults を実行するため、**タスク定義への仕込みが必要**。準備コストが高いので、
ネットワーク遅延・CPU 枯渇シナリオをやる回に計画的に導入する。初回 GameDay では stop-task 系を推奨。

必要な仕込み (公式ドキュメント [ecs-task-actions](https://docs.aws.amazon.com/fis/latest/userguide/ecs-task-actions.html) より):

1. **SSM エージェントのサイドカーコンテナ** をタスク定義に追加
   (イメージ: `public.ecr.aws/amazon-ssm-agent/amazon-ssm-agent:latest`、`essential: false`。
   起動コマンドでタスクを SSM マネージドインスタンスとして登録する — 公式ドキュメントのコマンドスクリプトをそのまま使う)
2. タスク定義の環境変数 `MANAGED_INSTANCE_ROLE_NAME` にマネージドインスタンスロール名を設定
3. **タスクロール**に: `ssm:CreateActivation`, `ssm:AddTagsToResource`, `iam:PassRole` (マネージドインスタンスロールに限定可)
4. **マネージドインスタンスロール** (新設): `AmazonSSMManagedInstanceCore` マネージドポリシー + `ssm:DeleteActivation`, `ssm:DeregisterManagedInstance`
5. **実験ロール**に: `ecs:DescribeTasks`, `ssm:SendCommand`, `ssm:ListCommands`, `ssm:CancelCommand`
6. タスク実行ロールに `AmazonECSTaskExecutionRolePolicy`

## RDS / Aurora アクション

### aws:rds:failover-db-cluster — Aurora のフェイルオーバー演習はこれ

- RDS API の `FailoverDBCluster` を実行。Aurora クラスタ対象
- ターゲット: `aws:rds:cluster`。パラメータなし
- 実験ロール権限: `rds:FailoverDBCluster`, `rds:DescribeDBClusters`, `tag:GetResources`(マネージドポリシー: `AWSFaultInjectionSimulatorRDSAccess`)
- 注意: フェイルオーバーには**リーダーインスタンスが必要**。Aurora Serverless v2 でライターのみ構成だと成立しない。シナリオの前提インフラに明記する

### aws:rds:reboot-db-instances

- ターゲット: `aws:rds:db` (インスタンス単位)
- パラメータ `forceFailover` は **Aurora には効かない** (Aurora は failover-db-cluster を使う)。接続断への挙動テスト用
- 実験ロール権限: `rds:RebootDBInstance`, `rds:DescribeDBInstances`, `tag:GetResources`

## その他このプロジェクトで候補になるアクション

- `aws:fis:wait` — 待機。「障害 → 観測時間 → 次の障害」のシーケンスを 1 実験に組める
- `aws:network:disrupt-connectivity` — サブネット単位の接続断 (AZ 障害の模擬)。パラメータ・権限は使用時に要確認

## ターゲットの絞り方 (爆発半径の制御)

- `selectionMode`: `ALL` / `COUNT(n)` / `PERCENT(n)`。GameDay では原則 `COUNT` / `PERCENT` を使う
- `resourceTags`: タグでの絞り込み。同タグが対象外リソースに付いていないか確認してから使う
- `parameters`: リソースタイプ固有のフィルタ。`aws:ecs:task` は `cluster` と `service` を指定できる

## 実験レポート (experimentReportConfiguration)

実験ごとに PDF レポートを自動生成できる。振り返りの一次資料。

- 内容: 実験アクションのサマリ + 指定した CloudWatch ダッシュボードの全ウィジェットのスナップショット(実験開始・終了時刻の注釈付き)
- 出力先: S3 バケット (+ FIS コンソールからもダウンロード可)。ダッシュボード指定時はウィジェット画像も配信される
- `preExperimentDuration` / `postExperimentDuration` (ISO 8601 duration, 例 `PT10M`) で前後の観測幅を指定 — 定常状態と回復を捉えるため
- キャンセルされた実験・`actionsMode: skip-all` (target preview) では生成されない
- レポート 1 通ごとに FIS の課金 + S3 / CloudWatch API (`GetMetricWidgetImage` 等) の課金がある。多数の試行では試行を target preview で済ませ、本番実験のみレポートを付けるのが安い
- CDK (L1) プロパティ: `experimentReportConfiguration: { outputs: { experimentReportS3Configuration: { bucketName, prefix } }, dataSources: { cloudWatchDashboards: [{ dashboardIdentifier }] }, preExperimentDuration, postExperimentDuration }` (aws-cdk-lib 2.258.1 で確認)

## CDK 実装の注意

- `aws-cdk-lib/aws-fis` は **L1 のみ** (`CfnExperimentTemplate`, `CfnTargetAccountConfiguration`)。L2 は存在しない (2.258.1 時点)
- 停止条件は `stopConditions: [{ source: 'aws:cloudwatch:alarm', value: alarmArn }]`。「なし」は `source: 'none'` だが GameDay では使わない

## 出典

- https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html
- https://docs.aws.amazon.com/fis/latest/userguide/ecs-task-actions.html
- https://docs.aws.amazon.com/fis/latest/userguide/targets.html
- https://docs.aws.amazon.com/fis/latest/userguide/experiment-report-configuration.html
