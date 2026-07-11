#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AppStack } from '../lib/app-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { FisStack } from '../lib/fis-stack';
import { LegacyAppStack } from '../lib/legacy-app-stack';
import { suppressGamedayLabFindings } from '../lib/nag-suppressions';

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
const fisStack = new FisStack(app, `${prefix}-Fis`, {
  stopAlarm: observability.stopAlarm,
  targetTagKey: appStack.targetTagKey,
  targetTagValue: appStack.targetTagValue,
  databaseCluster: appStack.databaseCluster,
});

// scenario-03 (EC2 突然死 → ECS 復旧): 学習用の SPOF 出発点スタック。
// 本流 3 スタックとは独立。必要な回だけ `cdk deploy GameDay-Legacy` で単体デプロイする。
const legacyStack = new LegacyAppStack(app, `${prefix}-Legacy`);

// GameDay のリソースを識別しやすくするタグ (爆発半径の確認用)
cdk.Tags.of(app).add('Project', 'mini-gameday');

// cdk-nag: AWS ベストプラクティス検査。通常の deploy は速さ優先で無効、
// `npm run synth:nag` (= cdk synth -c nag=true) のときだけ全スタックを検査する。
// 意図的な GameDay トレードオフは NagSuppressions により理由付きで抑制済み。
for (const stack of [appStack, observability, fisStack, legacyStack]) {
  suppressGamedayLabFindings(stack);
}
if (app.node.tryGetContext('nag') === 'true') {
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
}
