import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { TargetApp } from './constructs/target-app';
import { Observability } from './constructs/observability';
import { FaultInjection } from './constructs/fault-injection';
import { SlackNotify } from './constructs/slack-notify';

/**
 * ミニ GameDay の本体スタック (3 本柱を 1 スタックに統合)。
 *
 * かつては App / Observability / Fis の 3 スタックに分かれ、ALB や Aurora、停止条件
 * アラームを cross-stack props で渡していた。これは CloudFormation の Export/ImportValue
 * (Strong Reference) となり、参照元リソースの削除・変更が困難になる頻出トラブル源。
 * aws-cdk-development スキルの鉄則1・2 に従い、関心分離は Stack 分割ではなく Construct
 * 分割で行い、参照は全て同一スタック内で閉じるようにした (Export は生じない)。
 * scenario-03 の GameDay-Legacy は deploy ライフサイクルが異なるため別スタックのまま。
 */
export class GamedayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1) 対象アプリ: ALB + Fargate (お題)
    const targetApp = new TargetApp(this, 'TargetApp');

    // 2) 振り返り: Synthetics (Playwright) + CloudWatch アラーム/ダッシュボード
    const observability = new Observability(this, 'Observability', {
      loadBalancer: targetApp.loadBalancer,
      targetGroup: targetApp.targetGroup,
      databaseCluster: targetApp.databaseCluster,
    });

    // 3) 障害注入: FIS 実験テンプレート (停止条件 = 振り返りアラーム)
    //    -c faultDelayMinutes=5 で「start-experiment から 5 分後に障害」にできる (aws:fis:wait)。
    const faultDelayRaw = this.node.tryGetContext('faultDelayMinutes');
    new FaultInjection(this, 'FaultInjection', {
      stopAlarm: observability.stopAlarm,
      targetTagKey: targetApp.targetTagKey,
      targetTagValue: targetApp.targetTagValue,
      databaseCluster: targetApp.databaseCluster,
      faultDelayMinutes: faultDelayRaw != null ? Number(faultDelayRaw) : undefined,
    });

    // 4) Slack 通知: canary 成功率が下がる=障害発生 / 戻る=復旧 を Slack へ。
    //    Slack ワークスペース/チャンネル ID は context で渡す (認可後に取得)。
    //    未指定なら SNS までを作り Slack 連携はスキップ。
    new SlackNotify(this, 'SlackNotify', {
      canary: observability.canary,
      slackWorkspaceId: this.node.tryGetContext('slackWorkspaceId'),
      slackChannelId: this.node.tryGetContext('slackChannelId'),
    });
  }
}
