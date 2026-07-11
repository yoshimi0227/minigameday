import { test, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { GamedayStack } from '../lib/gameday-stack';
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

test('snapshot: 本体スタック (GamedayStack = 対象アプリ + 振り返り + 障害注入)', () => {
  const app = new cdk.App();
  const stack = new GamedayStack(app, 'GameDay');
  expect(maskedTemplate(stack)).toMatchSnapshot('GameDay');
});

test('snapshot: scenario-03 出発点スタック (LegacyApp)', () => {
  const app = new cdk.App();
  const legacy = new LegacyAppStack(app, 'Legacy');
  expect(maskedTemplate(legacy)).toMatchSnapshot('LegacyApp');
});
