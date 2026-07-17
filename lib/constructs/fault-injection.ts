import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

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
  /** scale-to-zero (対応ラウンド) の対象 Fargate サービス */
  readonly service: ecs.IService;
  /** 対象サービスが属する ECS クラスター */
  readonly cluster: ecs.ICluster;
  /**
   * 障害注入を start-experiment から何分遅らせるか (aws:fis:wait を先頭に挿入)。
   * 0 / 未指定なら即時。1〜720 分。start-experiment をデプロイ直後に叩けば
   * 「デプロイ + N 分後に障害」になる。待機は障害の前なので停止条件は誤発火しない。
   *
   * `"5-15"` 形式の範囲を渡すと synth 時に実験テンプレートごとに独立な乱数で分数が
   * 決まる (両端含む)。参加者は「いつ障害が来るか」を予測できず、エスカレーションで
   * 発火する 2 発目も別の遅延になる。値はテンプレートに焼き込まれるため、変えるには
   * 再デプロイ (synth) が必要。
   */
  readonly faultDelayMinutes?: number | string;
  /** 乱数源 (テスト用の差し替え口)。既定は Math.random */
  readonly random?: () => number;
}

/**
 * faultDelayMinutes の指定値を分数に解決する。
 * - 数値 / `"7"`: そのまま (0 = 遅延なし、それ以外は 1〜720 の整数)
 * - `"5-15"`: 両端含む一様乱数で整数を 1 つ引く (呼ぶたびに変わる = 実験ごとに独立)
 */
export function resolveFaultDelayMinutes(
  spec: number | string,
  random: () => number = Math.random,
): number {
  const fail = (): never => {
    throw new Error(`faultDelayMinutes は 1〜720 の整数か "5-15" 形式の範囲にする (指定値: ${spec})`);
  };
  const [low, high] = ((): [number, number] => {
    if (typeof spec === 'number') return [spec, spec];
    const parts = spec.split('-');
    if (parts.length > 2 || parts.some((p) => !/^\d+$/.test(p))) return fail();
    const nums = parts.map(Number);
    return nums.length === 2 ? [nums[0], nums[1]] : [nums[0], nums[0]];
  })();
  if (!Number.isInteger(low) || !Number.isInteger(high)) fail();
  if (low === 0 && high === 0) return 0; // 0 = 遅延なし (既定)
  if (low < 1 || high > 720 || low > high) fail();
  return low + Math.floor(random() * (high - low + 1));
}

/**
 * 障害注入の本体。AWS FIS 実験テンプレートを定義する。
 * - シナリオ1: Fargate タスクを 1 つ停止 (アプリ層の冗長性)
 * - シナリオ2: Aurora をフェイルオーバー (データ層の回復)
 */
export class FaultInjection extends Construct {
  /** シナリオ1 (Fargate タスク停止) の FIS 実験テンプレート ID */
  public readonly stopTaskTemplateId: string;
  /** シナリオ2 (Aurora フェイルオーバー) の FIS 実験テンプレート ID */
  public readonly failoverDbTemplateId: string;
  /** シナリオ5 (Fargate を desiredCount=0 に落とす。自己回復しない) の FIS 実験テンプレート ID */
  public readonly scaleToZeroTemplateId: string;

  constructor(scope: Construct, id: string, props: FaultInjectionProps) {
    super(scope, id);

    const { stopAlarm, targetTagKey, targetTagValue, databaseCluster, service, cluster } = props;

    const stopCondition: fis.CfnExperimentTemplate.ExperimentTemplateStopConditionProperty = {
      source: 'aws:cloudwatch:alarm',
      value: stopAlarm.alarmArn,
    };

    // 障害開始の遅延 (aws:fis:wait を先頭に挿入)。1〜720 分。0/未指定なら即時。
    // 範囲指定 ("5-15") なら withDelay を呼ぶたび = 実験テンプレートごとに独立に乱数を引く。
    const delaySpec = props.faultDelayMinutes ?? 0;
    const random = props.random ?? Math.random;
    // 障害アクションの手前に待機を挟んだ actions を作る。待機は「障害の前」なので、
    // 待機中は何も壊れておらず 5xx 停止条件が誤発火しない (後ろに足すのとは別)。
    const withDelay = (
      faultName: string,
      faultAction: fis.CfnExperimentTemplate.ExperimentTemplateActionProperty,
    ): Record<string, fis.CfnExperimentTemplate.ExperimentTemplateActionProperty> => {
      const delayMin = resolveFaultDelayMinutes(delaySpec, random);
      if (delayMin === 0) return { [faultName]: faultAction };
      return {
        Wait: {
          actionId: 'aws:fis:wait',
          description: `障害開始を ${delayMin} 分遅らせる`,
          parameters: { duration: `PT${delayMin}M` },
        },
        [faultName]: { ...faultAction, startAfter: ['Wait'] },
      };
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
      actions: withDelay('StopTask', {
        actionId: 'aws:ecs:stop-task',
        description: 'Stop one targeted Fargate task',
        targets: { Tasks: 'Tasks' },
      }),
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
          // Aurora は deploy 時に ARN が確定する安定リソースなので、タグではなく CDK 参照経由の
          // ARN で名指しする (同一スタック内では ARN の方が正確。ephemeral な ECS タスクはタグ選択)。
          // selectionMode: ALL でも対象は resourceArns の 1 クラスタに限定される。
          resourceArns: [databaseCluster.clusterArn],
        },
      },
      actions: withDelay('Failover', {
        actionId: 'aws:rds:failover-db-cluster',
        description: 'Force an Aurora cluster failover',
        targets: { Clusters: 'Clusters' },
      }),
    });

    // ===== シナリオ5 (対応ラウンド): Fargate を desiredCount=0 に落とす =====
    // FIS には ECS の desiredCount を変えるネイティブアクションが無いので、SSM Automation
    // (ecs:UpdateService desiredCount=0) を aws:ssm:start-automation-execution で実行する。
    // 復元ステップは入れない = 参加者が desiredCount を戻すまで復旧しない (対応ラウンドの肝)。

    // SSM Automation が assume するロール。ecs:UpdateService だけを対象サービスに限定する。
    const automationRole = new iam.Role(this, 'ScaleToZeroAutomationRole', {
      assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
      description: 'GameDay SSM automation role (ECS scale to zero)',
    });
    automationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
        resources: [service.serviceArn],
      }),
    );

    // desiredCount=0 に落とすだけの Automation ドキュメント (aws:executeAwsApi 1 ステップ)。
    const scaleDoc = new ssm.CfnDocument(this, 'ScaleToZeroDoc', {
      documentType: 'Automation',
      documentFormat: 'JSON',
      content: {
        schemaVersion: '0.3',
        description: 'GameDay: set the target ECS service desiredCount to 0 (no auto-recovery)',
        assumeRole: '{{ AutomationAssumeRole }}',
        parameters: {
          AutomationAssumeRole: { type: 'String' },
          Cluster: { type: 'String' },
          Service: { type: 'String' },
        },
        mainSteps: [
          {
            name: 'ScaleToZero',
            action: 'aws:executeAwsApi',
            inputs: {
              Service: 'ecs',
              Api: 'UpdateService',
              cluster: '{{ Cluster }}',
              service: '{{ Service }}',
              desiredCount: 0,
            },
          },
        ],
      },
    });

    const stack = cdk.Stack.of(this);
    const ssmRole = new iam.Role(this, 'FisSsmRole', {
      assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
      description: 'GameDay FIS role (SSM automation: ECS scale to zero)',
      // aws:ssm:start-automation-execution 用のマネージドポリシー (ssm automation 権限一式)。
      // ECS/RDS ロールと同じく AWS 提供のポリシーを使う (inline 最小化より確実)。
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSFaultInjectionSimulatorSSMAccess',
        ),
      ],
    });
    // automation ロールを SSM に渡す権限 (documentParameters の AutomationAssumeRole)
    ssmRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [automationRole.roleArn] }),
    );
    ssmRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['cloudwatch:DescribeAlarms'], resources: ['*'] }),
    );
    ssmRole.addToPolicy(new iam.PolicyStatement({ actions: LOG_DELIVERY_ACTIONS, resources: ['*'] }));

    const scaleToZeroTemplate = new fis.CfnExperimentTemplate(this, 'ScaleToZero', {
      description: 'GameDay: Fargate を desiredCount=0 に落とす。自己回復しないので参加者が戻すまで復旧しない',
      roleArn: ssmRole.roleArn,
      stopConditions: [stopCondition],
      logConfiguration,
      tags: { Name: 'gameday-scale-to-zero' },
      // aws:ssm:start-automation-execution はターゲット不要だが L1 は targets 必須なので空で渡す
      // (対象は documentParameters の Cluster/Service で指定する)
      targets: {},
      actions: withDelay('ScaleToZero', {
        actionId: 'aws:ssm:start-automation-execution',
        description: 'Run SSM automation that sets the ECS service desiredCount to 0',
        parameters: {
          // FIS の documentArn は document/ 形式の ARN (automation-definition 形式は弾かれる)
          documentArn: stack.formatArn({
            service: 'ssm',
            resource: 'document',
            resourceName: scaleDoc.ref,
          }),
          // トークンを含む JSON は toJsonString で組む (JSON.stringify はトークンを解決できない)
          documentParameters: stack.toJsonString({
            AutomationAssumeRole: automationRole.roleArn,
            Cluster: cluster.clusterName,
            Service: service.serviceName,
          }),
          // 自動化は数秒で終わるが、最低 1 分。fault の 5xx が閾値に達する前に実験は completed になる
          maxDuration: 'PT1M',
        },
      }),
    });

    this.stopTaskTemplateId = stopTaskTemplate.attrId;
    this.failoverDbTemplateId = failoverDbTemplate.attrId;
    this.scaleToZeroTemplateId = scaleToZeroTemplate.attrId;

    new cdk.CfnOutput(this, 'StopTaskTemplateId', {
      value: stopTaskTemplate.attrId,
      description: 'シナリオ1: aws fis start-experiment --experiment-template-id <これ>',
    });
    new cdk.CfnOutput(this, 'FailoverDbTemplateId', {
      value: failoverDbTemplate.attrId,
      description: 'シナリオ2: aws fis start-experiment --experiment-template-id <これ>',
    });
    new cdk.CfnOutput(this, 'ScaleToZeroTemplateId', {
      value: scaleToZeroTemplate.attrId,
      description: 'シナリオ5 (対応ラウンド): aws fis start-experiment --experiment-template-id <これ>',
    });
  }
}
