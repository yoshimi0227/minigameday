import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';

export interface GameEventsProps {
  /** 影響開始 (ALARM) / 復旧 (OK) の判定に使う canary ヘルスアラーム */
  readonly healthAlarm: cloudwatch.IAlarm;
  /** イベントの書き込み先 (gameday-score テーブルに EVENT# アイテムとして同居させる) */
  readonly table: dynamodb.ITableV2;
  /** 記録対象の FIS 実験テンプレート ID (これ以外の実験イベントは拾わない) */
  readonly experimentTemplateIds: string[];
}

/**
 * 自動採点のためのゲームイベント記録 (AWS ネイティブ)。
 *
 *   canary ヘルスアラーム (ALARM/OK) ─┐
 *                                     ├→ EventBridge ルール → Lambda → DynamoDB (EVENT#)
 *   FIS 実験の状態遷移 ───────────────┘
 *
 * ダッシュボードの dev サーバが EVENT# をポーリングして gameday.json にマージし、
 * 「影響開始 → 検知宣言 → 復旧」のタイムスタンプから点数を自動計算する。
 * イベントの解釈 (inject への帰属・採点) はダッシュボード側 (dashboard/src/scoring.ts) に
 * 集約し、ここは「起きたことを漏れなく記録する」ことだけに責任を持つ。
 * EVENT# は pk!='SCORE' なので ScoreEscalation のストリームフィルタには乗らない (再帰なし)。
 */
export class GameEvents extends Construct {
  constructor(scope: Construct, id: string, props: GameEventsProps) {
    super(scope, id);

    if (props.experimentTemplateIds.length === 0) {
      throw new Error('GameEvents には最低 1 つの experimentTemplateId が要る');
    }

    // 記録の取りこぼしの受け皿。EventBridge → Lambda は非同期呼び出しで、ハンドラが
    // 失敗し続けると既定 2 回のリトライ後にイベントが黙って消える (= 採点素材の欠落)。
    // DLQ に残せば「いつ何を取り逃したか」を後から確認し、手書きフォールバック
    // (experimentStartedAt 等) で補える。
    const dlq = new sqs.Queue(this, 'RecorderDlq', {
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    const recorder = new nodejs.NodejsFunction(this, 'Recorder', {
      entry: path.join(__dirname, '..', '..', 'lambda', 'game-events', 'index.mjs'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(10),
      deadLetterQueue: dlq,
      logGroup: new logs.LogGroup(this, 'RecorderLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      // score-escalator と同じ方針: SDK はランタイム同梱に頼らず esbuild で明示同梱する。
      // 出力は CJS にする (実機で確認済みの罠 2 連):
      //  1. ESM 出力 + CJS の SDK は require シムが無く "Dynamic require of 'node:https'
      //     is not supported" で Init クラッシュする。
      //  2. 定石の createRequire banner は Windows のローカルバンドルでシェルに
      //     ダブルクォートを剥がされ SyntaxError になる。
      // ソース (.mjs) は ESM のまま esbuild が CJS へ変換する (トップレベル await 不使用)。
      bundling: { format: nodejs.OutputFormat.CJS, externalModules: [], minify: false },
      environment: {
        TABLE_NAME: props.table.tableName,
      },
    });

    // EVENT# アイテムの条件付き PutItem 用。読み取りや FIS の権限は付けない (記録係に徹する)
    props.table.grants.writeData(recorder);

    // canary ヘルスアラームの状態遷移。INSUFFICIENT_DATA (起動直後) は採点に無関係なので捨てる
    new events.Rule(this, 'AlarmStateRule', {
      description: 'GameDay: canary ヘルスアラームの ALARM/OK 遷移を記録する',
      eventPattern: {
        source: ['aws.cloudwatch'],
        detailType: ['CloudWatch Alarm State Change'],
        resources: [props.healthAlarm.alarmArn],
        detail: { state: { value: ['ALARM', 'OK'] } },
      },
      targets: [new targets.LambdaFunction(recorder)],
    });

    // GameDay の実験テンプレートに限った FIS 実験の状態遷移。
    // running = 実験開始 (aws:fis:wait 中は障害はまだ = ダッシュボードでは「armed」表示)
    new events.Rule(this, 'FisStateRule', {
      description: 'GameDay: FIS 実験の状態遷移 (running/completed/stopped/failed) を記録する',
      eventPattern: {
        source: ['aws.fis'],
        detailType: ['FIS Experiment State Change'],
        detail: {
          'experiment-template-id': props.experimentTemplateIds,
          'new-state': { status: ['running', 'completed', 'stopped', 'failed'] },
        },
      },
      targets: [new targets.LambdaFunction(recorder)],
    });
  }
}
