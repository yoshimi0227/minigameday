#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { FisStack } from '../lib/fis-stack';

const app = new cdk.App();

// env は固定しない (environment-agnostic)。
// deploy 時は `cdk` CLI の現在のアカウント/リージョンが使われ、VPC の AZ は
// Fn::GetAZs で解決されるため、合成時に ec2:DescribeAvailabilityZones を必要としない。
// 特定アカウントに固定したい場合は各スタックに env: { account, region } を渡す。
const prefix = 'GameDay';

// 1) 対象アプリ: ALB + Fargate (お題)
const appStack = new AppStack(app, `${prefix}-App`);

// 2) 振り返り: Synthetics (Playwright) + CloudWatch アラーム/ダッシュボード
const observability = new ObservabilityStack(app, `${prefix}-Observability`, {
  loadBalancer: appStack.loadBalancer,
  targetGroup: appStack.targetGroup,
  databaseCluster: appStack.databaseCluster,
});

// 3) 障害注入: FIS 実験テンプレート (停止条件 = 振り返りアラーム)
new FisStack(app, `${prefix}-Fis`, {
  stopAlarm: observability.stopAlarm,
  targetTagKey: appStack.targetTagKey,
  targetTagValue: appStack.targetTagValue,
  databaseCluster: appStack.databaseCluster,
});

// GameDay のリソースを識別しやすくするタグ (爆発半径の確認用)
cdk.Tags.of(app).add('Project', 'mini-gameday');
