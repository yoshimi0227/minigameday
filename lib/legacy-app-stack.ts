import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * scenario-03 (単一 EC2 の突然死 → ECS への作り替えで復旧) の出発点スタック。
 *
 * これは「学習用にあえて壊れやすくした」構成。本流の GameDay-App (Fargate 冗長) とは別物で、
 * 単一 EC2 (Auto Scaling なし = SPOF) でアプリを動かす。FIS でこの EC2 を terminate し、
 * 参加者が同じコンテナイメージを ECS (Fargate) サービスとして手で組み直して復旧させる。
 *
 * 自己完結: このスタック単体で deploy / destroy できる (本流 3 スタックに依存しない)。
 * 復旧材料 (ECR イメージ / ECS クラスタ / タスク実行ロール / ロググループ / 共有 SG) も
 * 同梱し、参加者はコンソール/CLI からこれらを組み合わせるだけで復旧できる。
 */
export class LegacyAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- ネットワーク (public: ALB / app: EC2・Fargate / data: Aurora) ---
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // アプリのコンテナイメージ。EC2 (出発点) と参加者の Fargate (復旧先) が同じものを使う。
    const appImage = new ecrAssets.DockerImageAsset(this, 'AppImage', {
      directory: path.join(__dirname, '..', 'app'),
    });

    // --- データ層: Aurora MySQL Serverless v2 (ライターのみ。scenario-03 に冗長は不要) ---
    const database = new rds.DatabaseCluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_10_4,
      }),
      writer: rds.ClusterInstance.serverlessV2('writer'),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 1,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      credentials: rds.Credentials.fromGeneratedSecret('admin'),
      defaultDatabaseName: 'gameday',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      storageEncrypted: true,
    });

    // アプリ層の共有セキュリティグループ。EC2 (出発点) がこれを使い、
    // 参加者が作る Fargate サービスもこれを流用することで DB へ到達できる。
    const appSecurityGroup = new ec2.SecurityGroup(this, 'AppSg', {
      vpc,
      description: 'gameday-legacy app (shared by EC2 SPOF and rebuilt Fargate service)',
    });
    database.connections.allowDefaultPortFrom(appSecurityGroup, 'app -> Aurora');

    // --- 出発点の単一 EC2 (SPOF): user data で Docker により app イメージを起動 ---
    const instance = new ec2.Instance(this, 'LegacyServer', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: appSecurityGroup,
      // SSM 経由の操作 (デバッグ用)。踏み台不要
      ssmSessionPermissions: true,
    });
    // FIS のターゲット選択タグ (この値のインスタンスは環境全体でこの 1 台であること)
    cdk.Tags.of(instance).add('GameDayScenario', '03');

    // EC2 がイメージ pull と DB シークレット取得をできるように
    appImage.repository.grantPull(instance.role);
    database.secret!.grantRead(instance.role);

    const registry = `${cdk.Aws.ACCOUNT_ID}.dkr.ecr.${cdk.Aws.REGION}.amazonaws.com`;
    // -x (xtrace) は付けない: DB_SECRET を取得/展開する行がそのまま cloud-init ログに
    // 平文で出てしまうため。デバッグは SSM Session Manager + docker logs で行う。
    instance.userData.addCommands(
      'set -euo pipefail',
      'dnf install -y docker',
      'systemctl enable --now docker',
      `aws ecr get-login-password --region ${cdk.Aws.REGION} | docker login --username AWS --password-stdin ${registry}`,
      `DB_SECRET=$(aws secretsmanager get-secret-value --region ${cdk.Aws.REGION} --secret-id ${database.secret!.secretArn} --query SecretString --output text)`,
      'docker run -d --restart always -p 80:80 ' +
        `-e DB_HOST=${database.clusterEndpoint.hostname} ` +
        `-e DB_PORT=${cdk.Tokenization.stringifyNumber(database.clusterEndpoint.port)} ` +
        '-e DB_NAME=gameday ' +
        '-e DB_SECRET="$DB_SECRET" ' +
        appImage.imageUri,
    );

    // --- Web/LB 層: ALB + ターゲットグループ (必ず ip 型) ---
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
    });
    // ip 型にする理由: 復旧で参加者が載せる Fargate タスク (awsvpc) は ip 型にしか登録できない。
    // instance 型で作ると参加者が既存 TG を再利用できず詰む。ip 型なら EC2 の私設 IP も Fargate も載る。
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'AppTg', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [new elbv2Targets.IpTarget(instance.instancePrivateIp)],
      healthCheck: {
        path: '/healthz',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        interval: cdk.Duration.seconds(15),
      },
      deregistrationDelay: cdk.Duration.seconds(10),
    });
    loadBalancer.addListener('Http', {
      port: 80,
      open: true,
      defaultTargetGroups: [targetGroup],
    });
    // ALB -> app:80 を許可
    appSecurityGroup.connections.allowFrom(loadBalancer, ec2.Port.tcp(80), 'ALB -> app');

    // --- 復旧材料 (参加者が組み合わせる。事前に存在しないと制限時間内に終わらない) ---
    const rebuildCluster = new ecs.Cluster(this, 'RebuildCluster', {
      vpc,
      clusterName: 'gameday-rebuild',
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    const rebuildLogGroup = new logs.LogGroup(this, 'RebuildLogs', {
      logGroupName: '/gameday/rebuild',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // タスク実行ロール: ECR pull + Logs (マネージドポリシー) + DB シークレット読み取り
    const taskExecutionRole = new iam.Role(this, 'RebuildTaskExecRole', {
      roleName: 'gameday-rebuild-task-exec',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    database.secret!.grantRead(taskExecutionRole);

    // --- 障害注入: FIS で SPOF の EC2 を terminate ---
    // 停止条件: canary ではなく手動 kill switch を使う。rebuild 型は「canary 赤」が正常な
    // ゲーム進行なので、canary 連動アラームを停止条件にすると開始直後に自動停止してしまう。
    const abortAlarm = new cloudwatch.Alarm(this, 'AbortAlarm', {
      alarmName: 'gameday-legacy-abort',
      alarmDescription: '運営用 kill switch: put-metric-data GameDay/Abort=1 で実験を止める',
      metric: new cloudwatch.Metric({
        namespace: 'GameDay',
        metricName: 'Abort',
        statistic: 'Maximum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const fisRole = new iam.Role(this, 'FisRole', {
      roleName: 'gameday-legacy-fis-role',
      assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
      description: 'GameDay scenario-03 FIS role (terminate single EC2)',
    });
    // 爆発半径を IAM 側でも二重化: terminate は GameDayScenario=03 タグのインスタンスに限定
    fisRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:TerminateInstances'],
        resources: ['*'],
        conditions: { StringEquals: { 'ec2:ResourceTag/GameDayScenario': '03' } },
      }),
    );
    fisRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances', 'cloudwatch:DescribeAlarms'],
        resources: ['*'],
      }),
    );

    // 実験レポート (PDF) の配信先と、レポート生成に必要な権限
    const reportBucket = new s3.Bucket(this, 'FisReportBucket', {
      bucketName: `gameday-legacy-fis-reports-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, // SSE-S3 なのでレポート配信に KMS 権限は不要
      enforceSSL: true,
    });
    // レポート配信には s3:GetObject + s3:PutObject の両方が要る (grantWrite だけでは足りない)。
    // AWS 推奨に従いレポートのプレフィックスに限定する。
    reportBucket.grantReadWrite(fisRole, 'scenario-03/*');
    fisRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:GetMetricWidgetImage', 'cloudwatch:GetDashboard'],
        resources: ['*'],
      }),
    );

    // 進行表示と振り返りの一次資料になる外形監視 + ダッシュボード
    const canary = new synthetics.Canary(this, 'LegacyCanary', {
      canaryName: 'gameday-legacy-top',
      runtime: synthetics.Runtime.SYNTHETICS_NODEJS_PLAYWRIGHT_6_0,
      test: synthetics.Test.custom({
        code: synthetics.Code.fromAsset(path.join(__dirname, '..', 'canaries', 'top-page')),
        handler: 'index.handler',
      }),
      schedule: synthetics.Schedule.rate(cdk.Duration.minutes(1)),
      environmentVariables: { URL: `http://${loadBalancer.loadBalancerDnsName}` },
    });
    const dashboard = new cloudwatch.Dashboard(this, 'ReviewDashboard', {
      dashboardName: 'gameday-legacy-review',
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Canary 成功率 (%) — 赤=障害中/復旧作業中, 緑=復旧',
        left: [canary.metricSuccessPercent({ period: cdk.Duration.minutes(1) })],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB 5xx / Healthy Host',
        left: [loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT)],
        right: [targetGroup.metrics.healthyHostCount()],
        width: 12,
      }),
    );

    const experiment = new fis.CfnExperimentTemplate(this, 'TerminateEc2Experiment', {
      description: 'scenario-03: 単一 EC2 (SPOF) を terminate。参加者が ECS 化で復旧する',
      roleArn: fisRole.roleArn,
      stopConditions: [{ source: 'aws:cloudwatch:alarm', value: abortAlarm.alarmArn }],
      tags: { Name: 'gameday-scenario-03-terminate-ec2', gameday: 'true' },
      targets: {
        SpofInstance: {
          resourceType: 'aws:ec2:instance',
          selectionMode: 'COUNT(1)',
          resourceTags: { GameDayScenario: '03' },
          // タグに加え VPC でも二重に絞り、稼働中のものだけを対象にする
          filters: [
            { path: 'VpcId', values: [vpc.vpcId] },
            { path: 'State.Name', values: ['running'] },
          ],
        },
      },
      actions: {
        Terminate: {
          actionId: 'aws:ec2:terminate-instances',
          description: 'Terminate the single SPOF EC2 instance',
          targets: { Instances: 'SpofInstance' },
        },
      },
      // terminate はワンショットで実験は数十秒で completed になる。復旧までの長い観測は
      // postExperimentDuration (上限 2h) でレポート窓に収める。aws:fis:wait は足さない。
      experimentReportConfiguration: {
        outputs: {
          experimentReportS3Configuration: {
            bucketName: reportBucket.bucketName,
            prefix: 'scenario-03/',
          },
        },
        dataSources: {
          cloudWatchDashboards: [{ dashboardIdentifier: dashboard.dashboardName }],
        },
        preExperimentDuration: 'PT10M',
        postExperimentDuration: 'PT75M',
      },
    });

    // --- ハンドアウト: 参加者が復旧に使う値 (ダッシュボード or 紙で配る) ---
    const out = (key: string, value: string, description: string) =>
      new cdk.CfnOutput(this, key, { value, description });

    out('AlbUrl', `http://${loadBalancer.loadBalancerDnsName}`, '対象アプリ URL (canary の監視先)');
    out('ExperimentTemplateId', experiment.attrId, 'aws fis start-experiment --experiment-template-id <これ>');
    out('RebuildImageUri', appImage.imageUri, '復旧タスク定義に使うコンテナイメージ URI');
    out('RebuildDbHost', database.clusterEndpoint.hostname, 'DB_HOST');
    out('RebuildDbSecretArn', database.secret!.secretArn, 'DB_SECRET (Secrets Manager ARN)');
    out('RebuildClusterName', rebuildCluster.clusterName, 'ECS クラスタ (復旧先)');
    out('RebuildTaskExecRoleArn', taskExecutionRole.roleArn, 'タスク実行ロール ARN (iam:PassRole 対象)');
    out('RebuildLogGroup', rebuildLogGroup.logGroupName, 'awslogs のロググループ');
    out('RebuildTargetGroupArn', targetGroup.targetGroupArn, '既存の ip 型ターゲットグループ (Fargate を載せる先)');
    out('AppSecurityGroupId', appSecurityGroup.securityGroupId, 'app 用 SG (Fargate サービスに流用して DB 到達)');
    out('AppSubnetIds', vpc.selectSubnets({ subnetGroupName: 'app' }).subnetIds.join(','), 'Fargate を置く app サブネット');
  }
}
