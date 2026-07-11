import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as rds from 'aws-cdk-lib/aws-rds';

export interface FisStackProps extends cdk.StackProps {
  /** 実験の停止条件に使う CloudWatch アラーム */
  readonly stopAlarm: cloudwatch.IAlarm;
  /** FIS が対象タスクを選ぶタグのキー/値 (AppStack と一致させる) */
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
export class FisStack extends cdk.Stack {
  public readonly stopTaskTemplate: fis.CfnExperimentTemplate;
  public readonly failoverDbTemplate: fis.CfnExperimentTemplate;

  constructor(scope: Construct, id: string, props: FisStackProps) {
    super(scope, id, props);

    const { stopAlarm, targetTagKey, targetTagValue, databaseCluster } = props;

    const stopCondition: fis.CfnExperimentTemplate.ExperimentTemplateStopConditionProperty = {
      source: 'aws:cloudwatch:alarm',
      value: stopAlarm.alarmArn,
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

    this.stopTaskTemplate = new fis.CfnExperimentTemplate(this, 'StopOneTask', {
      description: 'GameDay: Fargate タスクを 1 つ停止し、冗長性と回復を観察する',
      roleArn: ecsRole.roleArn,
      stopConditions: [stopCondition],
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

    this.failoverDbTemplate = new fis.CfnExperimentTemplate(this, 'FailoverDb', {
      description: 'GameDay: Aurora をフェイルオーバーし、書き込み先切替時の挙動を観察する',
      roleArn: rdsRole.roleArn,
      stopConditions: [stopCondition],
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
      value: this.stopTaskTemplate.attrId,
      description: 'シナリオ1: aws fis start-experiment --experiment-template-id <これ>',
    });
    new cdk.CfnOutput(this, 'FailoverDbTemplateId', {
      value: this.failoverDbTemplate.attrId,
      description: 'シナリオ2: aws fis start-experiment --experiment-template-id <これ>',
    });
  }
}
