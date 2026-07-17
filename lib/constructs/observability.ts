import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as rds from 'aws-cdk-lib/aws-rds';

export interface ObservabilityProps {
  // インターフェース型で受け取る (awscdk/no-construct-in-interface)
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  readonly targetGroup: elbv2.IApplicationTargetGroup;
  readonly databaseCluster: rds.IDatabaseCluster;
}

/**
 * 振り返り (Reflection) の仕組み。
 * - CloudWatch Synthetics の Playwright ランタイムでユーザー目線の外形監視
 * - 顧客影響 (5xx) を捉える CloudWatch アラーム = FIS の停止条件
 * - 障害前後を見比べるダッシュボード
 */
export class Observability extends Construct {
  public readonly canary: synthetics.ICanary;
  public readonly stopAlarm: cloudwatch.IAlarm;
  /** 振り返りダッシュボード (gameday-review) の ARN。FIS 実験レポートの dataSources に使う */
  public readonly dashboardArn: string;

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);

    const { loadBalancer, targetGroup, databaseCluster } = props;

    // --- 外形監視: Synthetics (Playwright ランタイム) ---
    // 成果物 (スクショ/ログ) 置き場は自前バケットにする。L2 任せの自動バケットは
    // DeletionPolicy: Retain のため、都度 destroy 運用だと毎回残骸として溜まる。
    const artifactsBucket = new s3.Bucket(this, 'CanaryArtifacts', {
      bucketName: `gameday-canary-artifacts-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // 毎分の canary がスクショ/ログを吐き続ける。周回リセット運用 (destroy しない) だと
      // 溜まる一方なので 7 日で失効させる (振り返りは直近ぶんで足りる)
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
    });
    const canary = new synthetics.Canary(this, 'TopPageCanary', {
      canaryName: 'gameday-top',
      runtime: synthetics.Runtime.SYNTHETICS_NODEJS_PLAYWRIGHT_6_0,
      test: synthetics.Test.custom({
        code: synthetics.Code.fromAsset(path.join(__dirname, '..', '..', 'canaries', 'top-page')),
        handler: 'index.handler',
      }),
      schedule: synthetics.Schedule.rate(cdk.Duration.minutes(1)),
      environmentVariables: {
        // canary スクリプトが叩く対象 URL
        URL: `http://${loadBalancer.loadBalancerDnsName}`,
      },
      artifactsBucketLocation: { bucket: artifactsBucket },
      // canary 削除時に基盤 Lambda も削除する (S3 は対象外なので上の自前バケットで対処)
      provisionedResourceCleanup: true,
    });
    this.canary = canary;

    // --- 顧客影響メトリクス (5xx) ---
    const elb5xx = loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
      period: cdk.Duration.minutes(1),
      statistic: 'Sum',
    });
    const target5xx = targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
      period: cdk.Duration.minutes(1),
      statistic: 'Sum',
    });

    // FIS の停止条件: 顧客影響 (5xx) が想定を超えたら実験を自動停止する
    const stopAlarm = new cloudwatch.Alarm(this, 'Http5xxStopAlarm', {
      alarmName: 'gameday-5xx-stop-condition',
      alarmDescription: 'FIS 停止条件: 5xx が想定の爆発半径を超えたら実験を止める',
      metric: new cloudwatch.MathExpression({
        expression: 'elb + target',
        usingMetrics: { elb: elb5xx, target: target5xx },
        period: cdk.Duration.minutes(1),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.stopAlarm = stopAlarm;

    // canary 成功率 (振り返りの主指標)
    const canarySuccess = canary.metricSuccessPercent({ period: cdk.Duration.minutes(1) });

    // --- 振り返りダッシュボード ---
    const dashboard = new cloudwatch.Dashboard(this, 'ReviewDashboard', {
      dashboardName: 'gameday-review',
    });
    this.dashboardArn = dashboard.dashboardArn;
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Canary 成功率 (%)',
        left: [canarySuccess],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB / Target 5xx (顧客影響)',
        left: [elb5xx, target5xx],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Healthy Host Count (冗長性)',
        left: [targetGroup.metrics.healthyHostCount()],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Target Response Time',
        left: [targetGroup.metrics.targetResponseTime()],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Aurora 接続数 (データ層)',
        left: [databaseCluster.metricDatabaseConnections()],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Aurora CPU 使用率 (データ層)',
        left: [databaseCluster.metricCPUUtilization()],
        width: 12,
      }),
    );

    new cdk.CfnOutput(this, 'StopAlarmArn', { value: stopAlarm.alarmArn });
    new cdk.CfnOutput(this, 'DashboardName', { value: dashboard.dashboardName });
  }
}
