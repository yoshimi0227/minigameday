import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as chatbot from 'aws-cdk-lib/aws-chatbot';

export interface SlackNotifyProps {
  /** ヘルス判定に使う canary (成功率が下がったら障害) */
  readonly canary: synthetics.ICanary;
  /**
   * Slack ワークスペース ID / チャンネル ID。両方揃ったときだけ AWS Chatbot を作る。
   * ワークスペース ID は Amazon Q Developer in chat applications コンソールで Slack を
   * 一度認可したあとに取得する (context: `-c slackWorkspaceId=... -c slackChannelId=...`)。
   */
  readonly slackWorkspaceId?: string;
  readonly slackChannelId?: string;
}

/**
 * GameDay の障害/復旧を Slack に通知する仕組み。
 * - canary の成功率が 100% を下回る = 障害発生 (ALARM)
 * - 100% に戻る = 復旧 (OK)
 * 1 つの CloudWatch アラームの ALARM / OK 遷移を SNS に流し、AWS Chatbot が Slack へ。
 *
 * 注意: AWS Chatbot は事前に Slack ワークスペースの認可 (コンソールでの OAuth) が必要。
 * 未設定 (context 無し) の場合は SNS までを作り、Slack 連携はスキップする (他環境でも deploy 可)。
 * また起動直後に INSUFFICIENT_DATA → OK の遷移で「正常」通知が 1 度出る (= 監視稼働の合図)。
 */
export class SlackNotify extends Construct {
  /**
   * canary ヘルスアラーム (gameday-canary-health)。ALARM = 障害の影響開始 / OK = 復旧
   * のトグルとして GameEvents (自動採点のイベント記録) も参照する。
   */
  public readonly healthAlarm: cloudwatch.IAlarm;

  constructor(scope: Construct, id: string, props: SlackNotifyProps) {
    super(scope, id);

    const topic = new sns.Topic(this, 'IncidentTopic', {
      topicName: 'gameday-incidents',
      displayName: 'GameDay incidents',
    });

    // canary 成功率 (1 分粒度)。1 回でも失敗すると Average < 100 になる。
    const successPercent = new cloudwatch.Metric({
      namespace: 'CloudWatchSynthetics',
      metricName: 'SuccessPercent',
      dimensionsMap: { CanaryName: props.canary.canaryName },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    const healthAlarm = new cloudwatch.Alarm(this, 'CanaryHealth', {
      alarmName: 'gameday-canary-health',
      alarmDescription:
        'GameDay: canary 成功率が 100% を下回ったら障害発生、100% に戻ったら復旧。Slack 通知に使う。',
      metric: successPercent,
      threshold: 100,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      // 起動直後/データなしは OK 扱い (障害と誤判定しない)
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const snsAction = new cloudwatchActions.SnsAction(topic);
    healthAlarm.addAlarmAction(snsAction); // ALARM = 障害発生 → Slack
    healthAlarm.addOkAction(snsAction); // OK    = 復旧     → Slack
    this.healthAlarm = healthAlarm;

    // 監視の空白の検知: healthAlarm は treatMissingData=NOT_BREACHING なので、canary 自体が
    // 止まる (ランタイム廃止・クォータ・手動停止などでメトリクスが欠測する) と全アラームが
    // OK のままになり、誰も監視が死んだことに気づけない。SampleCount (5 分間の実行回数) を
    // 見張り、0 なら BREACHING で運営に知らせる。ゲームの採点イベントには使わない
    // (GameEvents が拾うのは healthAlarm だけ)。
    const heartbeatAlarm = new cloudwatch.Alarm(this, 'CanaryHeartbeat', {
      alarmName: 'gameday-canary-heartbeat',
      alarmDescription:
        'GameDay: canary が 5 分間 1 回も実行されていない (監視の空白)。canary の状態を確認する。',
      metric: new cloudwatch.Metric({
        namespace: 'CloudWatchSynthetics',
        metricName: 'SuccessPercent',
        dimensionsMap: { CanaryName: props.canary.canaryName },
        statistic: 'SampleCount',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      // 欠測 = canary が動いていない = まさに検知したい状態
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    heartbeatAlarm.addAlarmAction(snsAction); // 監視停止 → Slack
    heartbeatAlarm.addOkAction(snsAction); // 監視復帰 → Slack

    if (props.slackWorkspaceId && props.slackChannelId) {
      new chatbot.SlackChannelConfiguration(this, 'Slack', {
        slackChannelConfigurationName: 'gameday-incidents',
        slackWorkspaceId: props.slackWorkspaceId,
        slackChannelId: props.slackChannelId,
        notificationTopics: [topic],
      });
    } else {
      new cdk.CfnOutput(this, 'SlackNote', {
        value: 'Slack 未設定 (SNS のみ)。認可後に -c slackWorkspaceId=... -c slackChannelId=... で有効化',
        description: 'Slack 通知の状態',
      });
    }

    new cdk.CfnOutput(this, 'IncidentTopicArn', {
      value: topic.topicArn,
      description: 'GameDay 障害/復旧通知の SNS トピック',
    });
  }
}
