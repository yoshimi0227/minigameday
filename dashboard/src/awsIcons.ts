// AWS 公式アーキテクチャアイコン (aws-icons パッケージ = AWS Architecture Icons の SVG 配布)。
// gameday.json の systems[].tiers[].nodes[].icon / tiers[].icon はこのキーを指す。
// 新しいサービスが要るときは aws-icons のファイルをここに import してキーを増やす
// (ファイル一覧: node_modules/aws-icons/icons/。キーが無い/不明でも描画は壊れずアイコン無しになる)。

// --- ノード用 (サービス / リソースアイコン) ---
import users from 'aws-icons/icons/resource/Users.svg';
import client from 'aws-icons/icons/resource/Client.svg';
import synthetics from 'aws-icons/icons/resource/AmazonCloudWatchSynthetics.svg';
import alarm from 'aws-icons/icons/resource/AmazonCloudWatchAlarm.svg';
import cloudwatch from 'aws-icons/icons/architecture-service/AmazonCloudWatch.svg';
import alb from 'aws-icons/icons/resource/ElasticLoadBalancingApplicationLoadBalancer.svg';
import ecs from 'aws-icons/icons/architecture-service/AmazonElasticContainerService.svg';
import fargate from 'aws-icons/icons/architecture-service/AWSFargate.svg';
import ec2 from 'aws-icons/icons/resource/AmazonEC2Instance.svg';
import aurora from 'aws-icons/icons/architecture-service/AmazonAurora.svg';
import rds from 'aws-icons/icons/architecture-service/AmazonRDS.svg';
import route53 from 'aws-icons/icons/architecture-service/AmazonRoute53.svg';
import secretsManager from 'aws-icons/icons/architecture-service/AWSSecretsManager.svg';
import fis from 'aws-icons/icons/architecture-service/AWSFaultInjectionService.svg';
import dynamodb from 'aws-icons/icons/architecture-service/AmazonDynamoDB.svg';
import lambda from 'aws-icons/icons/architecture-service/AWSLambda.svg';
import s3 from 'aws-icons/icons/architecture-service/AmazonSimpleStorageService.svg';
import natGateway from 'aws-icons/icons/resource/AmazonVPCNATGateway.svg';
import internetGateway from 'aws-icons/icons/resource/AmazonVPCInternetGateway.svg';

// --- 層 (グループ) 用 ---
import awsCloud from 'aws-icons/icons/architecture-group/AWSCloud.svg';
import region from 'aws-icons/icons/architecture-group/Region.svg';
import vpc from 'aws-icons/icons/architecture-group/VirtualprivatecloudVPC.svg';
import publicSubnet from 'aws-icons/icons/architecture-group/Publicsubnet.svg';
import privateSubnet from 'aws-icons/icons/architecture-group/Privatesubnet.svg';

export const AWS_ICONS: Record<string, string> = {
  users,
  client,
  synthetics,
  alarm,
  cloudwatch,
  alb,
  ecs,
  fargate,
  ec2,
  aurora,
  rds,
  route53,
  'secrets-manager': secretsManager,
  fis,
  dynamodb,
  lambda,
  s3,
  'nat-gateway': natGateway,
  'internet-gateway': internetGateway,
  'aws-cloud': awsCloud,
  region,
  vpc,
  'public-subnet': publicSubnet,
  'private-subnet': privateSubnet,
};
