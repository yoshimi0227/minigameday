import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

/** スコア閾値 → 自動発火する FIS 実験の対応。id はトリガーの一意キー (冪等クレームにも使う)。 */
export interface EscalationTrigger {
  readonly id: string;
  /** 実効スコアがこの値に達したら発火 */
  readonly atScore: number;
  /** 発火させる FIS 実験テンプレート ID */
  readonly experimentTemplateId: string;
  /** ダッシュボード/ログ用の表示名 */
  readonly label: string;
}

export interface ScoreEscalationProps {
  readonly triggers: EscalationTrigger[];
  /**
   * DynamoDB テーブル名。ダッシュボードの dev サーバ (vite.config.ts の /api/score) が
   * この名前で put-item するため、固定名にして両者を一致させる。
   * @default 'gameday-score'
   */
  readonly tableName?: string;
}

/**
 * スコア閾値到達で「次の障害」を自動発火する仕組み (AWS ネイティブ)。
 *
 *   ダッシュボード (実効スコアを計算) → dev サーバ /api/score → DynamoDB (SCORE アイテム)
 *     → DynamoDB Streams → この Lambda → 閾値判定 → FIS start-experiment
 *
 * スコアはゲーム状態なので CloudWatch メトリクスではなく DynamoDB に持ち、Streams で
 * イベント駆動にする。閾値判定と発火 (StartExperiment)・冪等性は全て AWS 側で完結する。
 */
export class ScoreEscalation extends Construct {
  public readonly table: dynamodb.ITableV2;

  constructor(scope: Construct, id: string, props: ScoreEscalationProps) {
    super(scope, id);

    if (props.triggers.length === 0) {
      throw new Error('ScoreEscalation には最低 1 つの trigger が要る');
    }

    // スコア置き場。SCORE アイテム (現在値) と FIRED#<id> アイテム (発火済みフラグ) を持つ。
    // Streams で「SCORE の更新」を Lambda に流す。使い捨てラボなので DESTROY + オンデマンド課金。
    const table = new dynamodb.TableV2(this, 'ScoreTable', {
      tableName: props.tableName ?? 'gameday-score',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      dynamoStream: dynamodb.StreamViewType.NEW_IMAGE,
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.table = table;

    const escalator = new nodejs.NodejsFunction(this, 'Escalator', {
      entry: path.join(__dirname, '..', '..', 'lambda', 'score-escalator', 'index.mjs'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'EscalatorLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      // ランタイム同梱 SDK に client-fis がある保証がないため esbuild で明示的に同梱する
      // (externalModules: [] = 何も外部化せず全てバンドル)。esbuild は Vite+ 同梱を使う。
      bundling: { format: nodejs.OutputFormat.ESM, externalModules: [], minify: false },
      environment: {
        TABLE_NAME: table.tableName,
        TRIGGERS: JSON.stringify(
          props.triggers.map((t) => ({
            id: t.id,
            atScore: t.atScore,
            experimentTemplateId: t.experimentTemplateId,
            label: t.label,
          })),
        ),
      },
    });

    // 冪等クレーム (FIRED#<id> の条件付き PutItem) 用の書き込み権限
    table.grantWriteData(escalator);

    // FIS 実験を開始する権限。開始で作られる experiment は生成 ID なので experiment/* が要る。
    // 対象はこのアカウント/リージョンの実験テンプレート・実験に限定 (grant 相当の最小)。
    const stack = cdk.Stack.of(this);
    escalator.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['fis:StartExperiment'],
        resources: [
          stack.formatArn({ service: 'fis', resource: 'experiment-template', resourceName: '*' }),
          stack.formatArn({ service: 'fis', resource: 'experiment', resourceName: '*' }),
        ],
      }),
    );

    // DynamoDB Streams → Lambda。SCORE アイテムの INSERT/MODIFY だけに絞り、
    // FIRED# 書き込みや他アイテムでは起動しない (無駄な起動と再帰を防ぐ)。
    escalator.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 5,
        retryAttempts: 2,
        filters: [
          lambda.FilterCriteria.filter({
            eventName: ['INSERT', 'MODIFY'],
            dynamodb: { Keys: { pk: { S: ['SCORE'] } } },
          }),
        ],
      }),
    );

    new cdk.CfnOutput(this, 'ScoreTableName', {
      value: table.tableName,
      description: 'ダッシュボード dev サーバがスコアを put-item する DynamoDB テーブル',
    });
  }
}
