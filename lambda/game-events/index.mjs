// ゲームイベント記録 Lambda。
// EventBridge から「canary ヘルスアラームの状態遷移 (ALARM/OK)」と「FIS 実験の状態遷移」を
// 受け取り、DynamoDB (gameday-score) に EVENT# アイテムとして書き溜める。
// ダッシュボードの dev サーバがこれをポーリングして gameday.json にマージし、
// 検知・復旧時刻からの自動採点に使う (= 対応状況がそのまま点数になる仕組みの記録係)。
//
// 設計:
// - pk = EVENT#<発生時刻>#<EventBridge イベント ID>。時刻先頭 = 文字列ソートで時系列、
//   イベント ID 込み + attribute_not_exists の条件付き PutItem = 再配送でも重複しない (冪等)。
// - ここではロジックを持たない (書くだけ)。イベントの絞り込みは EventBridge ルール側、
//   解釈 (どの inject に帰属するか・採点) はダッシュボード側 (dashboard/src/scoring.ts)。
// - EVENT# アイテムは pk!='SCORE' なので score-escalator のストリームフィルタに弾かれ、
//   エスカレーションを誤起動しない。

import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME;

export const handler = async (event) => {
  const pk = `EVENT#${event.time}#${event.id}`;
  const detail = event.detail ?? {};

  let item;
  if (event['detail-type'] === 'CloudWatch Alarm State Change') {
    item = {
      pk: { S: pk },
      type: { S: 'alarm' },
      at: { S: event.time },
      alarmName: { S: detail.alarmName ?? '' },
      state: { S: detail.state?.value ?? '' },
      // reason は表示用の短文だけ残す (reasonData は肥大するので保存しない)
      reason: { S: String(detail.state?.reason ?? '').slice(0, 300) },
    };
  } else if (event['detail-type'] === 'FIS Experiment State Change') {
    item = {
      pk: { S: pk },
      type: { S: 'experiment' },
      at: { S: event.time },
      experimentId: { S: detail['experiment-id'] ?? '' },
      experimentTemplateId: { S: detail['experiment-template-id'] ?? '' },
      status: { S: detail['new-state']?.status ?? '' },
    };
  } else {
    return { recorded: false };
  }

  try {
    await ddb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk)', // 再配送は黙って捨てる
      }),
    );
  } catch (err) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
  }
  console.log(JSON.stringify({ msg: 'game event recorded', pk, type: item.type.S }));
  return { recorded: true, pk };
};
