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

## EC2 アクション (rebuild 型シナリオ向け)

### aws:ec2:terminate-instances — SPOF の EC2 を終了させる

- EC2 API の `TerminateInstances` を実行。**取り消し不可のワンショット**
- ターゲット: `aws:ec2:instance`。`resourceTags` + `filters` (VpcId 等) で二重に絞る。パラメータなし
- 実験ロール権限: `ec2:TerminateInstances`, `ec2:DescribeInstances` (マネージドポリシー `AWSFaultInjectionSimulatorEC2Access` でも可だが広い。`ec2:ResourceTag` Condition 付き最小 inline を推奨)
- **注意**: ワンショットなので実験は数十秒で completed になる。`aws:fis:wait` を後ろに足すと待機中に停止条件アラームが発火して実験が stopped になり**実験レポートが失われる**。復旧までの長い観測は `postExperimentDuration` (最大 PT2H) でレポート窓に収める
- 検証日 2026-07-11 ([FIS Actions reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html))

## その他このプロジェクトで候補になるアクション

- `aws:fis:wait` — 待機 (`duration` PT1M〜PT12H、権限不要)。`startAfter` で順序付け。
  - **障害の前に置く = 開始遅延**: `Wait (PT5M) → Fault (startAfter: ['Wait'])` にすると start-experiment から 5 分後に障害。待機中は何も壊れていないので停止条件は誤発火しない (安全)。本プロジェクトは `faultDelayMinutes` prop / `-c faultDelayMinutes=N` でこれを可変にしている (FaultInjection Construct)。
  - **障害の後ろに置くのは注意**: ワンショット系 (terminate 等) の後ろに足すと待機中に停止条件アラームが発火して実験が stopped になり実験レポートが失われる。復旧の長い観測は `postExperimentDuration` を使う。
- `aws:network:disrupt-connectivity` — サブネット単位の接続断 (AZ / リージョン障害の模擬)。全サブネットを対象にすればリージョン全体の使用不能を模擬できる。パラメータ (scope, duration) ・権限は使用時に要確認

### aws:ssm:start-automation-execution — ネイティブアクションが無い操作を SSM Automation 経由で (検証日 2026-07-17)

FIS には ECS の desiredCount 変更や SG ルール削除のネイティブアクションが無い。SSM Automation
ドキュメント (`aws:executeAwsApi` ステップで任意の AWS API を呼ぶ) を FIS から起動して実現する。
scale-to-zero (scenario-05: `ecs:UpdateService desiredCount=0` = 自己回復しない障害) がこのパターン。

- ターゲット: **None** (ターゲット不要。対象は documentParameters で渡す。ただし L1 は `targets` 必須なので `targets: {}` を書く)
- パラメータ: `documentArn` / `documentVersion` (任意) / `documentParameters` (JSON 文字列) / `maxDuration` (PT1M〜PT12H)
- 実験ロール権限: `ssm:StartAutomationExecution`, `ssm:GetAutomationExecution`, `ssm:StopAutomationExecution`, `iam:PassRole` (automation ロールを SSM に渡す場合) + 停止条件用 `cloudwatch:DescribeAlarms` + ログ配信。マネージドポリシー `AWSFaultInjectionSimulatorSSMAccess` でも可 (広い)
- **`documentArn` は `document/` 形式の ARN** (`arn:aws:ssm:<region>:<account>:document/<名前>`)。`automation-definition/` 形式を渡すと deploy 時に `The 'documentArn' parameter value is not valid` で弾かれる (2026-07-17 実機で確認)。CDK では `stack.formatArn({ service: 'ssm', resource: 'document', resourceName: doc.ref })`
- **`documentParameters` にトークン (ARN / 名前) を含めるときは `JSON.stringify` ではなく `stack.toJsonString(...)`** を使う (JSON.stringify はトークンを文字列 `${Token[...]}` のまま埋めてしまう。toJsonString は Fn::Join に化けて deploy 時に解決される)
- **自己回復しない障害にするコツ**: Automation ドキュメントに「復元ステップを入れない」。実験は数秒で completed になるが、変更 (desiredCount=0 等) は残り、参加者が戻すまで復旧しない = 対応ラウンドの肝
- **停止条件との相性**: fault が 5xx を引き起こす場合でも、`maxDuration` を短く (PT1M) すれば自動化は数秒で終わり実験が completed になる → fault の 5xx が停止条件の閾値に達する前に実験は終わっている (停止条件で誤って止まらない)
- Automation の assume ロール: `ssm.amazonaws.com` が assume、実行する API の最小権限 (例 `ecs:UpdateService` を対象サービス ARN に限定) を持たせる
- CDK 実装例 (scenario-05): `ssm.CfnDocument` (documentType `Automation`, schemaVersion `0.3`, mainSteps に `aws:executeAwsApi`) + FIS action `aws:ssm:start-automation-execution`。詳細は `lib/constructs/fault-injection.ts` の ScaleToZero

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
- **`dashboardIdentifier` はダッシュボード ARN (`dashboard.dashboardArn`)。名前を渡すと deploy 時に `InvalidRequest` で失敗する** (synth は通る。実デプロイで発覚、2026-07-11)
- レポート配信には実験ロールに `s3:GetObject` + `s3:PutObject` の両方が要る (`grantWrite` だけでは不足) + `cloudwatch:GetDashboard` / `cloudwatch:GetMetricWidgetImage`

## 実験ログ (logConfiguration)

実験のタイムライン・アクション詳細を CloudWatch Logs または S3 に残せる。振り返りの素材。

- CDK (L1): `logConfiguration: { cloudWatchLogsConfiguration: { logGroupArn }, logSchemaVersion: 2 }`。**`logSchemaVersion` は必須** (現行 2)
- 実験ロールに必要な権限 (vended log delivery、Resource: '*'): `logs:CreateLogDelivery`, `logs:PutResourcePolicy`, `logs:DescribeResourcePolicies`, `logs:DescribeLogGroups`
- S3 出力なら `s3Configuration: { bucketName, prefix }`
- 実験レポート (PDF) とは別物。レポートはサマリ、ログは実行時の詳細。両方あると振り返りが厚くなる

## CDK 実装の注意

- `aws-cdk-lib/aws-fis` は **L1 のみ** (`CfnExperimentTemplate`, `CfnTargetAccountConfiguration`)。L2 は存在しない (2.258.1 時点)
- 停止条件は `stopConditions: [{ source: 'aws:cloudwatch:alarm', value: alarmArn }]`。「なし」は `source: 'none'` だが GameDay では使わない

## 出典

- https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html
- https://docs.aws.amazon.com/fis/latest/userguide/ecs-task-actions.html
- https://docs.aws.amazon.com/fis/latest/userguide/targets.html
- https://docs.aws.amazon.com/fis/latest/userguide/experiment-report-configuration.html
