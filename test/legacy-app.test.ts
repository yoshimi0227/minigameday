import { test, beforeAll } from 'vitest';
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
