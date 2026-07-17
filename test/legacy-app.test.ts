import { test, expect, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { LegacyAppStack } from '../lib/legacy-app-stack';

/**
 * scenario-03 (EC2 突然死 → ECS 復旧) の出発点スタックの fine-grained assertions。
 * synth が通っても壊れていると当日事故になる不変条件を固定する:
 *   - 意図した SPOF (EC2 は 1 台、Auto Scaling なし)
 *   - ターゲットグループが ip 型 (Fargate を復旧で載せられる前提)
 *   - FIS の爆発半径 (COUNT(1) + タグ + terminate アクション) と停止条件
 *   - 復旧材料 (ECS クラスタ / タスク実行ロール) が揃っている
 */

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new LegacyAppStack(app, 'Legacy');
  template = Template.fromStack(stack);
});

test('SPOF: EC2 は 1 台だけで、Auto Scaling Group を持たない', () => {
  template.resourceCountIs('AWS::EC2::Instance', 1);
  template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 0);
});

test('EC2 は FIS ターゲット用のタグ GameDayScenario=03 を持つ', () => {
  template.hasResourceProperties('AWS::EC2::Instance', {
    Tags: Match.arrayWith([{ Key: 'GameDayScenario', Value: '03' }]),
  });
});

test('ターゲットグループは ip 型 (Fargate を復旧で載せられる)', () => {
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    TargetType: 'ip',
    HealthCheckPath: '/healthz',
  });
});

test('FIS: EC2 を 1 台 terminate し、タグと VPC で二重に絞る', () => {
  template.hasResourceProperties('AWS::FIS::ExperimentTemplate', {
    Actions: Match.objectLike({
      Terminate: Match.objectLike({ ActionId: 'aws:ec2:terminate-instances' }),
    }),
    Targets: Match.objectLike({
      SpofInstance: Match.objectLike({
        ResourceType: 'aws:ec2:instance',
        SelectionMode: 'COUNT(1)',
        ResourceTags: { GameDayScenario: '03' },
      }),
    }),
    StopConditions: Match.arrayWith([Match.objectLike({ Source: 'aws:cloudwatch:alarm' })]),
  });
});

test('FIS: 実験レポートは設定済みで、復旧を待てる長い後観測窓を持つ', () => {
  template.hasResourceProperties('AWS::FIS::ExperimentTemplate', {
    ExperimentReportConfiguration: Match.objectLike({
      PostExperimentDuration: 'PT75M',
    }),
  });
});

test('FIS: 実験ログを CloudWatch Logs に残す (本体スタックと同じ振り返り素材)', () => {
  template.hasResourceProperties('AWS::FIS::ExperimentTemplate', {
    LogConfiguration: Match.objectLike({
      // CFN プロパティは PascalCase の LogGroupArn (camelCase だと early validation で弾かれる)
      CloudWatchLogsConfiguration: { LogGroupArn: Match.anyValue() },
      LogSchemaVersion: 2,
    }),
  });
});

test('停止条件アラームは欠測を BREACHING 扱いしない (canary 赤で誤発火させない)', () => {
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'gameday-legacy-abort',
    TreatMissingData: 'notBreaching',
  });
});

test('復旧材料: ECS クラスタとタスク実行ロールが揃っている', () => {
  template.hasResourceProperties('AWS::ECS::Cluster', { ClusterName: 'gameday-rebuild' });
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Principal: { Service: 'ecs-tasks.amazonaws.com' } }),
      ]),
    }),
  });
});

test('FIS ロールの terminate 権限はタグ条件で絞られている (爆発半径の二重化)', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'ec2:TerminateInstances',
          Condition: { StringEquals: { 'ec2:ResourceTag/GameDayScenario': '03' } },
        }),
      ]),
    }),
  });
});

test('本番モード: canary ヘルスアラーム (影響/復旧の記録用) を持つ。停止条件アラームとは別物', () => {
  // EC2 死亡=ALARM、rebuild 完了=OK を記録するアラーム。停止条件 (abort) とは独立
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'gameday-legacy-canary-health',
    ComparisonOperator: 'LessThanThreshold',
    Threshold: 100,
    TreatMissingData: 'notBreaching',
  });
  // abort (停止条件) + canary-health (記録) の 2 アラームがある
  template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
});

test('本番モード: GameEvents がアラーム遷移と FIS 状態遷移を同じ Lambda で記録する', () => {
  // EventBridge ルール 2 本 (アラーム状態遷移 + FIS 状態遷移)
  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: Match.objectLike({ 'detail-type': ['CloudWatch Alarm State Change'] }),
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: Match.objectLike({ 'detail-type': ['FIS Experiment State Change'] }),
  });
  template.resourceCountIs('AWS::Events::Rule', 2);
});

test('S3: canary 成果物バケットだけライフサイクル (7 日失効) を持つ (周回運用で溜め込まない)', () => {
  template.resourcePropertiesCountIs(
    'AWS::S3::Bucket',
    Match.objectLike({
      LifecycleConfiguration: {
        Rules: [Match.objectLike({ ExpirationInDays: 7, Status: 'Enabled' })],
      },
    }),
    1,
  );
});

test('本番モード: 記録 Lambda は gameday-score テーブルに書き込む (cross-stack Export なし)', () => {
  // テーブルは名前インポートなので Fn::ImportValue に化けない = 環境変数はリテラル名
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: Match.objectLike({ Variables: Match.objectLike({ TABLE_NAME: 'gameday-score' }) }),
  });
  // 名前インポートは Export を生じさせない
  const exported = Object.values(template.findOutputs('*')).filter((o) => 'Export' in o);
  expect(exported).toHaveLength(0);
});
