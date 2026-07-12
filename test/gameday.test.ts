import { test, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { GamedayStack } from '../lib/gameday-stack';
import { ScoreEscalation } from '../lib/constructs/score-escalation';

/**
 * Fine-grained assertions。
 * GameDay の肝になる「壊しても観察できる」構成 (冗長 2 タスク / FIS のタグ選択 /
 * 停止条件 / Playwright canary) が崩れていないことを守る。
 * 3 本柱は GamedayStack 1 つに統合されたので、1 テンプレートに対して検証する。
 */
// 既定 context の合成は Lambda を esbuild でバンドルするため重い。Template は読み取り専用の
// クエリオブジェクトなので、既定ビルドは 1 回だけ合成して共有する (テスト間で安全)。
let defaultTemplate: Template | undefined;
function buildTemplate(): Template {
  if (!defaultTemplate) {
    const app = new cdk.App();
    const stack = new GamedayStack(app, 'GameDay');
    defaultTemplate = Template.fromStack(stack);
  }
  return defaultTemplate;
}

test('対象アプリ: インターネット向け ALB の背後で Fargate が 2 タスク動く', () => {
  const t = buildTemplate();

  t.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 2 });
  t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
  });
  // ALB ヘルスチェックは DB 非依存の /healthz (canary が叩く "/" とは分離)
  t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    HealthCheckPath: '/healthz',
  });
});

test('データ層: Aurora MySQL Serverless v2 が作られる', () => {
  const t = buildTemplate();

  t.hasResourceProperties('AWS::RDS::DBCluster', {
    Engine: 'aurora-mysql',
    ServerlessV2ScalingConfiguration: Match.objectLike({
      MinCapacity: 0.5,
      MaxCapacity: 1,
    }),
  });
});

test('振り返り: canary は Playwright ランタイムを使う。アラームは停止条件+ヘルスの 2 つ', () => {
  const t = buildTemplate();

  t.hasResourceProperties('AWS::Synthetics::Canary', {
    RuntimeVersion: 'syn-nodejs-playwright-6.0',
  });
  // 停止条件 (5xx) + Slack 通知用ヘルス (canary 成功率) の 2 アラーム
  t.resourceCountIs('AWS::CloudWatch::Alarm', 2);
});

test('Slack 通知: canary ヘルスアラームが ALARM/OK 両方を SNS に流す', () => {
  const t = buildTemplate();

  // canary 成功率 < 100 で発火するヘルスアラーム。ALARM/OK 両方が同じ SNS トピックを参照
  const topicRef = Match.arrayWith([{ Ref: Match.stringLikeRegexp('SlackNotifyIncidentTopic') }]);
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'gameday-canary-health',
    ComparisonOperator: 'LessThanThreshold',
    Threshold: 100,
    AlarmActions: topicRef,
    OKActions: topicRef,
  });
  t.resourceCountIs('AWS::SNS::Topic', 1);
  // context 未指定なので Chatbot は作られない (他環境でも deploy 可)
  t.resourceCountIs('AWS::Chatbot::SlackChannelConfiguration', 0);
});

test('Slack 通知: context で workspace/channel を渡すと Chatbot が作られる', () => {
  const app = new cdk.App({
    context: { slackWorkspaceId: 'T0BA0DS8UH4', slackChannelId: 'C0BGHTVG5FV' },
  });
  const t = Template.fromStack(new GamedayStack(app, 'GameDaySlack'));
  t.hasResourceProperties('AWS::Chatbot::SlackChannelConfiguration', {
    SlackWorkspaceId: 'T0BA0DS8UH4',
    SlackChannelId: 'C0BGHTVG5FV',
  });
});

test('障害注入1: FIS は ECS タスクを 1 つ停止し、停止条件にアラームを使う', () => {
  const t = buildTemplate();

  t.hasResourceProperties('AWS::FIS::ExperimentTemplate', {
    Actions: Match.objectLike({
      StopTask: Match.objectLike({ ActionId: 'aws:ecs:stop-task' }),
    }),
    Targets: Match.objectLike({
      Tasks: Match.objectLike({
        ResourceType: 'aws:ecs:task',
        SelectionMode: 'COUNT(1)',
      }),
    }),
    StopConditions: Match.arrayWith([
      Match.objectLike({ Source: 'aws:cloudwatch:alarm' }),
    ]),
  });
});

test('障害注入: 両実験は CloudWatch Logs へ実験ログを残す (振り返りの素材)', () => {
  const t = buildTemplate();

  // 2 つの実験テンプレートとも logConfiguration (CloudWatch Logs) を持つ
  t.resourcePropertiesCountIs(
    'AWS::FIS::ExperimentTemplate',
    Match.objectLike({
      LogConfiguration: Match.objectLike({
        // CFN プロパティは PascalCase の LogGroupArn (camelCase だと early validation で弾かれる)
        CloudWatchLogsConfiguration: { LogGroupArn: Match.anyValue() },
        LogSchemaVersion: 2,
      }),
    }),
    2,
  );
});

test('障害注入2: FIS は Aurora クラスターをフェイルオーバーする', () => {
  const t = buildTemplate();

  // ECS / RDS で 2 つの実験テンプレートがある
  t.resourceCountIs('AWS::FIS::ExperimentTemplate', 2);
  t.hasResourceProperties('AWS::FIS::ExperimentTemplate', {
    Actions: Match.objectLike({
      Failover: Match.objectLike({ ActionId: 'aws:rds:failover-db-cluster' }),
    }),
    Targets: Match.objectLike({
      Clusters: Match.objectLike({
        ResourceType: 'aws:rds:cluster',
        SelectionMode: 'ALL',
      }),
    }),
  });
});

test('障害遅延: faultDelayMinutes を渡すと両実験の先頭に aws:fis:wait が入る', () => {
  const app = new cdk.App({ context: { faultDelayMinutes: 5 } });
  const t = Template.fromStack(new GamedayStack(app, 'GameDayDelay'));
  // 両実験に Wait (PT5M) が入る
  t.resourcePropertiesCountIs(
    'AWS::FIS::ExperimentTemplate',
    Match.objectLike({
      Actions: Match.objectLike({
        Wait: Match.objectLike({ ActionId: 'aws:fis:wait', Parameters: { duration: 'PT5M' } }),
      }),
    }),
    2,
  );
});

test('障害遅延: デフォルト (context 無し) は wait を入れない', () => {
  const t = buildTemplate();
  t.resourcePropertiesCountIs(
    'AWS::FIS::ExperimentTemplate',
    Match.objectLike({ Actions: Match.objectLike({ Wait: Match.anyValue() }) }),
    0,
  );
});

test('障害遅延: 範囲外 (720 分超) は synth 時に弾く', () => {
  const app = new cdk.App({ context: { faultDelayMinutes: 1000 } });
  expect(() => new GamedayStack(app, 'GameDayBadDelay')).toThrow(/faultDelayMinutes/);
});

test('スコアエスカレーション: DynamoDB(Streams) → Lambda → FIS 発火の配線がある', () => {
  const t = buildTemplate();

  // スコア置き場。TableV2 は GlobalTable として合成される。Streams(NEW_IMAGE)が Lambda を駆動
  t.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
    TableName: 'gameday-score',
    StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
  });
  // エスカレーション Lambda は最新ランタイムで TRIGGERS を持つ
  t.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs24.x',
    Environment: Match.objectLike({ Variables: Match.objectLike({ TRIGGERS: Match.anyValue() }) }),
  });
  // イベントソースは SCORE アイテムの INSERT/MODIFY だけに絞る (無駄起動と再帰を防ぐ)
  t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    FilterCriteria: {
      Filters: Match.arrayWith([{ Pattern: Match.stringLikeRegexp('SCORE') }]),
    },
  });
  // Lambda ロールに FIS 実験を開始する権限
  t.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({ Action: 'fis:StartExperiment' })]),
    }),
  });
});

test('スコアエスカレーション: 閾値と実験IDが Lambda 環境変数 (TRIGGERS) に入る', () => {
  // 実 ID はトークンになり CFN 上 Fn::Join に化けるので、単体では素の文字列で検証する
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'EscOnly');
  new ScoreEscalation(stack, 'Esc', {
    triggers: [{ id: 't1', atScore: 250, experimentTemplateId: 'EXTexample', label: 'x' }],
  });
  const t = Template.fromStack(stack);
  t.hasResourceProperties('AWS::Lambda::Function', {
    Environment: Match.objectLike({
      Variables: Match.objectLike({
        TRIGGERS: Match.stringLikeRegexp('"atScore":250.*"experimentTemplateId":"EXTexample"'),
      }),
    }),
  });
});

test('スコアエスカレーション: trigger 空は設定ミスとして弾く', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'EscEmpty');
  expect(() => new ScoreEscalation(stack, 'Esc', { triggers: [] })).toThrow(/trigger/);
});

test('統合の証明: 本体は 1 スタックで、cross-stack Export を作らない', () => {
  const t = buildTemplate();
  // Strong Reference (Export) が無いこと = 他スタックへ ImportValue で漏れていない
  t.findOutputs('*', Match.objectLike({ Export: Match.anyValue() }));
  const exported = Object.values(t.findOutputs('*')).filter((o) => 'Export' in o);
  if (exported.length > 0) {
    throw new Error(`予期しない Export が ${exported.length} 件ある (統合で cross-stack 参照は消えるはず)`);
  }
});
