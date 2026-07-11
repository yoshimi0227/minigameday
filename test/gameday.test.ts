import { test } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { FisStack } from '../lib/fis-stack';

/**
 * Fine-grained assertions。
 * GameDay の肝になる「壊しても観察できる」構成 (冗長 2 タスク / FIS のタグ選択 /
 * 停止条件 / Playwright canary) が崩れていないことを守る。
 */

function buildApp() {
  const app = new cdk.App();
  const appStack = new AppStack(app, 'App');
  const observability = new ObservabilityStack(app, 'Obs', {
    loadBalancer: appStack.loadBalancer,
    targetGroup: appStack.targetGroup,
    databaseCluster: appStack.databaseCluster,
  });
  const fisStack = new FisStack(app, 'Fis', {
    stopAlarm: observability.stopAlarm,
    targetTagKey: appStack.targetTagKey,
    targetTagValue: appStack.targetTagValue,
    databaseCluster: appStack.databaseCluster,
  });
  return { appStack, observability, fisStack };
}

test('対象アプリ: インターネット向け ALB の背後で Fargate が 2 タスク動く', () => {
  const { appStack } = buildApp();
  const t = Template.fromStack(appStack);

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
  const { appStack } = buildApp();
  const t = Template.fromStack(appStack);

  t.hasResourceProperties('AWS::RDS::DBCluster', {
    Engine: 'aurora-mysql',
    ServerlessV2ScalingConfiguration: Match.objectLike({
      MinCapacity: 0.5,
      MaxCapacity: 1,
    }),
  });
});

test('振り返り: canary は Playwright ランタイムを使う', () => {
  const { observability } = buildApp();
  const t = Template.fromStack(observability);

  t.hasResourceProperties('AWS::Synthetics::Canary', {
    RuntimeVersion: 'syn-nodejs-playwright-6.0',
  });
  t.resourceCountIs('AWS::CloudWatch::Alarm', 1);
});

test('障害注入1: FIS は ECS タスクを 1 つ停止し、停止条件にアラームを使う', () => {
  const { fisStack } = buildApp();
  const t = Template.fromStack(fisStack);

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

test('障害注入2: FIS は Aurora クラスターをフェイルオーバーする', () => {
  const { fisStack } = buildApp();
  const t = Template.fromStack(fisStack);

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
