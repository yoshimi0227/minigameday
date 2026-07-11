import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';

/**
 * GameDay の「お題」となる対象アプリ (3層構成)。
 * - Web/LB 層: ALB
 * - アプリ層 : Fargate (httpd)
 * - データ層 : Aurora MySQL Serverless v2 (隔離サブネット)
 * FIS はこのスタックのタスク/DB に障害を注入する。
 */
export class AppStack extends cdk.Stack {
  // 公開プロパティはインターフェース型で公開する (awscdk/no-construct-in-public-property-of-construct)
  public readonly cluster: ecs.ICluster;
  public readonly service: ecs.IFargateService;
  public readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly databaseCluster: rds.IDatabaseCluster;

  /** FIS がタグでタスクを選択するためのキー/値 */
  public readonly targetTagKey = 'GameDayTarget';
  public readonly targetTagValue = 'true';

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 3層に対応するサブネット: public(ALB) / app(Fargate) / data(Aurora)
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1, // コスト抑制: NAT Gateway は 1 つに
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED, // 振り返り用メトリクス
    });
    this.cluster = cluster;

    // --- データ層: Aurora MySQL Serverless v2 ---
    const databaseCluster = new rds.DatabaseCluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_10_4,
      }),
      writer: rds.ClusterInstance.serverlessV2('writer'),
      // フェイルオーバーの昇格先となるリーダーを別 AZ に1台 (FIS シナリオに必要)
      readers: [rds.ClusterInstance.serverlessV2('reader', { scaleWithWriter: true })],
      serverlessV2MinCapacity: 0.5, // コスト抑制
      serverlessV2MaxCapacity: 1,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      credentials: rds.Credentials.fromGeneratedSecret('admin'), // Secrets Manager に自動生成
      defaultDatabaseName: 'gameday',
      // デモ用: 後片付けしやすいよう破棄時に残さない
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      storageEncrypted: true,
    });
    this.databaseCluster = databaseCluster;

    // --- アプリ層: Fargate ---
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    taskDefinition.addContainer('app', {
      // app/ の Node アプリを Docker ビルド (deploy 時に Docker が必要)。
      // "/" で Aurora に SELECT 1 し、可否で 200/503 を返す。
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '..', 'app')),
      portMappings: [{ containerPort: 80 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'gameday-app' }),
      // データ層への接続情報をアプリ層へ受け渡し
      environment: {
        DB_HOST: databaseCluster.clusterEndpoint.hostname,
        DB_PORT: cdk.Tokenization.stringifyNumber(databaseCluster.clusterEndpoint.port),
        DB_NAME: 'gameday',
      },
      secrets: {
        // Secrets Manager のシークレット全体(JSON)を注入。アプリ側で username/password を取り出す。
        DB_SECRET: ecs.Secret.fromSecretsManager(databaseCluster.secret!),
      },
    });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 2, // 1 タスク落としても冗長性を観察できるよう 2
      minHealthyPercent: 50, // デプロイ/障害時に最低 1 タスクは維持
      circuitBreaker: { rollback: true }, // 起動失敗を素早く検知してロールバック
      // サービスのタグをタスクに伝播させ、FIS がタグで対象を選べるようにする
      propagateTags: ecs.PropagatedTagSource.SERVICE,
    });
    this.service = service;
    cdk.Tags.of(service).add(this.targetTagKey, this.targetTagValue);

    // アプリ層 → データ層 の通信を許可
    databaseCluster.connections.allowDefaultPortFrom(
      service,
      'Allow Fargate tasks to reach Aurora',
    );

    // --- Web/LB 層: ALB ---
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
    });
    this.loadBalancer = loadBalancer;

    const listener = loadBalancer.addListener('Http', {
      port: 80,
      open: true,
    });

    this.targetGroup = listener.addTargets('Ecs', {
      port: 80,
      targets: [service],
      healthCheck: {
        // DB 非依存の生存確認。DB 障害でもタスクは登録維持し、canary だけが "/" の 503 を捉える
        path: '/healthz',
        healthyThresholdCount: 2,
        interval: cdk.Duration.seconds(15),
      },
      deregistrationDelay: cdk.Duration.seconds(10), // 振り返りを速くするため短め
    });

    new cdk.CfnOutput(this, 'AlbUrl', {
      value: `http://${loadBalancer.loadBalancerDnsName}`,
      description: 'GameDay 対象アプリの URL',
    });
    new cdk.CfnOutput(this, 'DbEndpoint', {
      value: databaseCluster.clusterEndpoint.hostname,
      description: 'Aurora writer endpoint',
    });
  }
}
