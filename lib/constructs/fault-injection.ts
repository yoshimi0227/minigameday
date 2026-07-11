import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';

// FIS が CloudWatch Logs へログを配信するのに必要な権限 (vended log delivery)。
// ログ配信系のアクションはリソース単位で絞れないため resources は '*'。
const LOG_DELIVERY_ACTIONS = [
  'logs:CreateLogDelivery',
  'logs:PutResourcePolicy',
  'logs:DescribeResourcePolicies',
  'logs:DescribeLogGroups',
];

export interface FaultInjectionProps {
  /** 実験の停止条件に使う CloudWatch アラーム */
  readonly stopAlarm: cloudwatch.IAlarm;
  /** FIS が対象タスクを選ぶタグのキー/値 (TargetApp と一致させる) */
  readonly targetTagKey: string;
  readonly targetTagValue: string;
  /** フェイルオーバー対象の Aurora クラスター */
  readonly databaseCluster: rds.IDatabaseCluster;
}

/**
 * 障害注入の本体。AWS FIS 実験テンプレートを定義する。
 * - シナリオ1: Fargate タスクを 1 つ停止 (アプリ層の冗長性)
 * - シナリオ2: Aurora をフェイルオーバー (データ層の回復)
 */
export class FaultInjection extends Construct {
  constructor(scope: Construct, id: string, props: FaultInjectionProps) {
    super(scope, id);

    const { stopAlarm, targetTagKey, targetTagValue, databaseCluster } = props;

    const stopCondition: fis.CfnExperimentTemplate.ExperimentTemplateStopConditionProperty = {
      source: 'aws:cloudwatch:alarm',
      value: stopAlarm.alarmArn,
    };

    // 実験ログの配信先。実験タイムライン・アクション詳細を CloudWatch Logs に残し、
    // 振り返り (gameday-retrospective) の一次素材にする。両実験で共有する。
    const experimentLogs = new logs.LogGroup(this, 'ExperimentLogs', {
      logGroupName: '/gameday/fis-experiments',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // ハマりどころ 2 点 (実デプロイで判明、2026-07-11):
    // 1. FIS は末尾 ':*' 付きの log-group ARN を要求する。CDK の `logGroupArn` がまさに
    //    その形 (':*' = 全ログストリーム)。剥がすと FIS API が "not valid" で弾く。
    // 2. cloudWatchLogsConfiguration は CDK 上 `any` 型で case 変換されないため、CFN の
    //    プロパティ名 `LogGroupArn` (PascalCase) をそのまま書く。camelCase だと early
    //    validation で「未知のプロパティ」として弾かれる。
    const logConfiguration: fis.CfnExperimentTemplate.ExperimentTemplateLogConfigurationProperty = {
      cloudWatchLogsConfiguration: { LogGroupArn: experimentLogs.logGroupArn },
      logSchemaVersion: 2,
    };

    // ===== シナリオ1: ECS タスクを 1 つ停止 =====
    const ecsRole = new iam.Role(this, 'FisEcsRole', {
      assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
      description: 'GameDay FIS role (ECS stop-task)',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSFaultInjectionSimulatorECSAccess',
        ),
      ],
    });
    ecsRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['cloudwatch:DescribeAlarms'], resources: ['*'] }),
    );
    ecsRole.addToPolicy(new iam.PolicyStatement({ actions: LOG_DELIVERY_ACTIONS, resources: ['*'] }));

    const stopTaskTemplate = new fis.CfnExperimentTemplate(this, 'StopOneTask', {
      description: 'GameDay: Fargate タスクを 1 つ停止し、冗長性と回復を観察する',
      roleArn: ecsRole.roleArn,
      stopConditions: [stopCondition],
      logConfiguration,
      tags: { Name: 'gameday-stop-one-task' },
      targets: {
        Tasks: {
          resourceType: 'aws:ecs:task',
          selectionMode: 'COUNT(1)', // タスクを 1 つだけ停止
          resourceTags: { [targetTagKey]: targetTagValue },
        },
      },
      actions: {
        StopTask: {
          actionId: 'aws:ecs:stop-task',
          description: 'Stop one targeted Fargate task',
          targets: { Tasks: 'Tasks' },
        },
      },
    });

    // ===== シナリオ2: Aurora フェイルオーバー =====
    const rdsRole = new iam.Role(this, 'FisRdsRole', {
      assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
      description: 'GameDay FIS role (RDS failover)',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSFaultInjectionSimulatorRDSAccess',
        ),
      ],
    });
    rdsRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['cloudwatch:DescribeAlarms'], resources: ['*'] }),
    );
    rdsRole.addToPolicy(new iam.PolicyStatement({ actions: LOG_DELIVERY_ACTIONS, resources: ['*'] }));

    const failoverDbTemplate = new fis.CfnExperimentTemplate(this, 'FailoverDb', {
      description: 'GameDay: Aurora をフェイルオーバーし、書き込み先切替時の挙動を観察する',
      roleArn: rdsRole.roleArn,
      stopConditions: [stopCondition],
      logConfiguration,
      tags: { Name: 'gameday-failover-db' },
      targets: {
        Clusters: {
          resourceType: 'aws:rds:cluster',
          selectionMode: 'ALL',
          // 対象クラスターを ARN で直接指定
          resourceArns: [databaseCluster.clusterArn],
        },
      },
      actions: {
        Failover: {
          actionId: 'aws:rds:failover-db-cluster',
          description: 'Force an Aurora cluster failover',
          targets: { Clusters: 'Clusters' },
        },
      },
    });

    new cdk.CfnOutput(this, 'StopTaskTemplateId', {
      value: stopTaskTemplate.attrId,
      description: 'シナリオ1: aws fis start-experiment --experiment-template-id <これ>',
    });
    new cdk.CfnOutput(this, 'FailoverDbTemplateId', {
      value: failoverDbTemplate.attrId,
      description: 'シナリオ2: aws fis start-experiment --experiment-template-id <これ>',
    });
  }
}
