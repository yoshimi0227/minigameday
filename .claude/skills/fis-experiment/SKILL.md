---
name: fis-experiment
description: GameDay シナリオを AWS FIS 実験テンプレート (CDK) として実装する。「シナリオを FIS にして」「実験テンプレートを作って」「障害注入を実装して」「fault-injection を書いて/直して」など、FIS 実験の実装・修正・レビューの全てで必ず使う。FIS アクションの選定、停止条件 (CloudWatch アラーム)、実験ロールの最小権限 IAM、爆発半径の制御 (selectionMode)、実験レポート設定、ECS タスクアクションの SSM サイドカー前提条件など、検証済みの判断基準とコード例を提供する。lib/constructs/fault-injection.ts を編集するときは内容にかかわらず該当する。
---

# FIS 実験テンプレート実装 (シナリオ → CDK)

GameDay シナリオを AWS FIS 実験テンプレートとして `lib/constructs/fault-injection.ts` に落とすスキル。
目的は「安全に失敗できる」実験だけをデプロイさせること。停止条件のない実験や爆発半径の不明な実験は GameDay ではなくただの障害になる。デプロイ前に必ず下の安全装置チェックリストを通す。

## 実装フロー

1. **シナリオを読む** — `scenarios/` の対象ファイルから「注入する障害」「爆発半径」「停止条件」「前提インフラ」を確認する。シナリオがまだ無ければ先に `gameday-scenario` エージェントで立案する。設計と実装を分けるのは、実装の都合でシナリオの仮説が歪むのを防ぐため。
2. **アクション仕様を確認する** — まず [references/fis-actions.md](references/fis-actions.md) を読む(この 3 層構成で使う主要アクションの検証済みメモ)。そこに無いアクション・パラメータは AWS Knowledge MCP で FIS Actions reference を確認する。FIS は機能追加が速く、記憶にあるパラメータ名は古いことがある。
3. **CDK で実装する** — `aws-cdk-lib/aws-fis` は L1 (`CfnExperimentTemplate`) のみ。L2 を探さない。下の「実装の型」に従う。
4. **安全装置チェックリスト**を全項目 yes にする。
5. **テストを書く** — `aws-cdk-unit-testing` スキルの判断基準に従う。最低限「停止条件が設定されている」「selectionMode が意図した値である」ことは fine-grained assertion で固定する。この 2 つは壊れても synth が通ってしまい、実験当日に事故として発覚するため。

## 実装の型

```ts
import * as fis from 'aws-cdk-lib/aws-fis';

// 停止条件: 外形監視の成功率が落ちたら実験を強制停止する
const stopAlarm = new cloudwatch.Alarm(this, 'GamedayStopCondition', {
  alarmName: 'gameday-stop-condition',
  metric: new cloudwatch.Metric({
    namespace: 'CloudWatchSynthetics',
    metricName: 'SuccessPercent',
    dimensionsMap: { CanaryName: canary.canaryName },
    statistic: 'Average',
    period: cdk.Duration.minutes(1),
  }),
  comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
  threshold: 50,
  evaluationPeriods: 3,
  // canary が動いていない = 影響を観測できない状態では実験を続けない
  treatMissingData: cloudwatch.TreatMissingData.BREACHING,
});

const role = new iam.Role(this, 'GamedayFisRole', {
  roleName: 'gameday-fis-role',
  assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
});
// 権限はアクションごとの必要最小限 (references/fis-actions.md の権限一覧を見る)

new fis.CfnExperimentTemplate(this, 'StopTaskExperiment', {
  description: 'scenario-01: Fargate タスク 50% 停止でもユーザー影響なく自己回復するか',
  roleArn: role.roleArn,
  stopConditions: [{ source: 'aws:cloudwatch:alarm', value: stopAlarm.alarmArn }],
  targets: {
    'gameday-tasks': {
      resourceType: 'aws:ecs:task',
      selectionMode: 'PERCENT(50)', // 爆発半径: 稼働タスクの半分まで
      parameters: {
        cluster: props.cluster.clusterName,
        service: props.service.serviceName,
      },
    },
  },
  actions: {
    'stop-tasks': {
      actionId: 'aws:ecs:stop-task',
      targets: { Tasks: 'gameday-tasks' },
    },
  },
  // 実験レポート: 実験前後のダッシュボードスナップショット付き PDF が S3 に出る。
  // 振り返り (gameday-retrospective スキル) の一次資料になるので原則設定する
  experimentReportConfiguration: {
    outputs: {
      experimentReportS3Configuration: {
        bucketName: reportBucket.bucketName,
        prefix: 'fis-reports/',
      },
    },
    dataSources: {
      // dashboardIdentifier は名前でなく ARN (dashboard.dashboardArn)。名前を渡すと deploy 時に InvalidRequest
      cloudWatchDashboards: [{ dashboardIdentifier: dashboard.dashboardArn }],
    },
    preExperimentDuration: 'PT10M',
    postExperimentDuration: 'PT10M',
  },
  tags: { Name: 'gameday-scenario-01-stop-task', gameday: 'true' },
});
```

## 安全装置チェックリスト (deploy 前に全項目 yes)

- **停止条件**: canary ベースの CloudWatch アラームを `stopConditions` に設定した。`treatMissingData: BREACHING` にした(観測不能な実験は続行しない)。
- **爆発半径**: `selectionMode` を `COUNT(n)` / `PERCENT(n)` で明示した。`ALL` にする場合はその理由がシナリオに書いてある。
- **ターゲット限定**: `parameters` (cluster / service) や `resourceTags` で対象スタックのリソースだけに絞った。タグだけに頼る場合、同じタグが他リソースに付いていないか確認した。
- **IAM 最小権限**: 実験ロールは使用アクションに必要な権限のみ。`Resource: '*'` はタグ検索系 (`tag:GetResources`) に限る。
- **命名・タグ**: `gameday-*` 命名と `gameday` タグを付けた(振り返り時の識別、および誤って対象外に影響した際に気づけるように)。
- **レポート**: `experimentReportConfiguration` を設定した。省略する場合は振り返り手段を別途確保している。

## 実行前プリフライト (`aws fis start-experiment` の前)

- canary が RUNNING で、直近の成功率が安定している(ベースラインがないと振り返れない)。
- 停止条件アラームが OK 状態(最初から ALARM だと実験が即座に停止する)。
- `gameday-retrospective` スキルの「実験前」フェーズ(ベースライン記録・drift クリーン確認)を済ませた。
