#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { GamedayStack } from '../lib/gameday-stack';
import { LegacyAppStack } from '../lib/legacy-app-stack';
import { suppressGamedayLabFindings } from '../lib/nag-suppressions';

const app = new cdk.App();

// env は固定しない (environment-agnostic)。誰でも自分のアカウントに `cdk deploy`
// できる可搬性を優先した意図的な選択。deploy 時は `cdk` CLI の現在のアカウント/
// リージョンが使われ、VPC の AZ は Fn::GetAZs で解決されるため、合成時に
// ec2:DescribeAvailabilityZones を必要としない。特定アカウントに固定したい場合は
// 各スタックに env: { account, region } を渡す。
//
// パラメータ管理 (parameter.ts + AppParameter 型) も、単一の使い捨てラボのため
// 意図的に省いている。dev/stg/prd の複数環境やアカウント固定が必要になった時点で、
// aws-cdk-development スキルの design-principles 6 節に沿って導入する。
const prefix = 'GameDay';

// 本体: 対象アプリ + 振り返り + 障害注入を 1 スタックに統合 (関心分離は Construct 分割)。
// cross-stack Strong Reference を避けるため、以前の 3 スタック (App/Observability/Fis) は
// GamedayStack 配下の Construct にまとめた (aws-cdk-development スキル 鉄則1・2)。
const gameday = new GamedayStack(app, prefix);

// scenario-03 (EC2 突然死 → ECS 復旧): 学習用の SPOF 出発点スタック。
// 本体とは deploy ライフサイクルが異なるため独立。`cdk deploy GameDay-Legacy` で単体デプロイ。
const legacyStack = new LegacyAppStack(app, `${prefix}-Legacy`);

// アプリレベルの順序依存 (CFN Export は作らない)。legacy は gameday-score テーブルを
// 「名前」で参照する (fromTableName) ため、deploy は GameDay が先・destroy --all は
// Legacy が先でないと、legacy の recorder が実行時に書き込み先を失う。
legacyStack.addDependency(gameday, 'GameEvents が gameday-score テーブルを名前参照するため');

// GameDay のリソースを識別しやすくするタグ (爆発半径の確認用)
cdk.Tags.of(app).add('Project', 'mini-gameday');

// cdk-nag: AWS ベストプラクティス検査。通常の deploy は速さ優先で無効、
// `npm run synth:nag` (= cdk synth -c nag=true) のときだけ全スタックを検査する。
// 意図的な GameDay トレードオフは NagSuppressions により理由付きで抑制済み。
for (const stack of [gameday, legacyStack]) {
  suppressGamedayLabFindings(stack);
}
if (app.node.tryGetContext('nag') === 'true') {
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
}
