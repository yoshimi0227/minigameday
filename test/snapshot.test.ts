import { test, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { FisStack } from '../lib/fis-stack';
import { LegacyAppStack } from '../lib/legacy-app-stack';

/**
 * スナップショットテスト (aws-cdk-development スキル: 全プロジェクト最初に入れるべきテスト)。
 * 各スタックが出力する CloudFormation テンプレートを保存し、リファクタリングや
 * CDK バージョンアップで「意図しない差分」が出ていないことを検出する。
 * 差分が意図どおりなら `npx vp test run -u` で更新する。
 *
 * Docker/Synthetics アセットの 64 桁 hex ハッシュはソース変更で揺れるため、
 * マスクしてスナップショットを安定させる (アセットハッシュ問題)。
 */
function maskedTemplate(stack: cdk.Stack): unknown {
  const json = JSON.stringify(Template.fromStack(stack).toJSON());
  return JSON.parse(json.replace(/[a-f0-9]{64}/g, '[ASSET_HASH]'));
}

test('snapshot: 本流 3 スタック (App / Observability / Fis)', () => {
  const app = new cdk.App();
  const appStack = new AppStack(app, 'App');
  const observability = new ObservabilityStack(app, 'Obs', {
    loadBalancer: appStack.loadBalancer,
    targetGroup: appStack.targetGroup,
    databaseCluster: appStack.databaseCluster,
  });
  new FisStack(app, 'Fis', {
    stopAlarm: observability.stopAlarm,
    targetTagKey: appStack.targetTagKey,
    targetTagValue: appStack.targetTagValue,
    databaseCluster: appStack.databaseCluster,
  });

  expect(maskedTemplate(appStack)).toMatchSnapshot('App');
  expect(maskedTemplate(observability)).toMatchSnapshot('Observability');
  expect(maskedTemplate(app.node.findChild('Fis') as cdk.Stack)).toMatchSnapshot('Fis');
});

test('snapshot: scenario-03 出発点スタック (LegacyApp)', () => {
  const app = new cdk.App();
  const legacy = new LegacyAppStack(app, 'Legacy');
  expect(maskedTemplate(legacy)).toMatchSnapshot('LegacyApp');
});
