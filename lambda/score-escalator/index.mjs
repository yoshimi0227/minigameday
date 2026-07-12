// スコアエスカレーション Lambda。
// DynamoDB (gameday-score) の SCORE アイテムが更新されるたびに Streams で起動し、
// 実効スコアが閾値 (atScore) に達したトリガーがあれば FIS 実験を自動で開始する
// (= 「スコアが一定以上たまったら新たな障害が発生する」仕組みの発火点)。
//
// 冪等性: 各トリガーは 1 回だけ発火させたい。スコアは閾値を超えたまま何度も更新され得るので、
//   FIRED#<id> アイテムを attribute_not_exists で条件付き PutItem して「先勝ち」でクレームし、
//   クレームできたときだけ StartExperiment する。既にクレーム済みなら黙ってスキップ。
//   FIRED# アイテムの書き込みは pk!='SCORE' なのでイベントソースのフィルタで弾かれ、再帰しない。
//
// バンドル: aws-cdk-lib/aws-lambda-nodejs (esbuild) が @aws-sdk/* を同梱する
//   (ランタイム同梱 SDK に client-fis がある保証がないため、AWS 推奨どおり明示バンドル)。

import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { FisClient, StartExperimentCommand } from '@aws-sdk/client-fis';

const ddb = new DynamoDBClient({});
const fis = new FisClient({});

const TABLE_NAME = process.env.TABLE_NAME;
/** [{ id, atScore, experimentTemplateId, label }] — CDK が環境変数で注入 */
const TRIGGERS = JSON.parse(process.env.TRIGGERS ?? '[]');

export const handler = async (event) => {
  const fired = [];
  for (const record of event.Records ?? []) {
    if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') continue;
    const image = record.dynamodb?.NewImage;
    if (!image || image.pk?.S !== 'SCORE') continue;

    const total = Number(image.total?.N);
    if (!Number.isFinite(total)) continue;

    for (const trigger of TRIGGERS) {
      if (total < trigger.atScore) continue;

      // 冪等クレーム: 既に発火済みなら ConditionalCheckFailed で抜ける
      try {
        await ddb.send(
          new PutItemCommand({
            TableName: TABLE_NAME,
            Item: {
              pk: { S: `FIRED#${trigger.id}` },
              firedAt: { S: new Date().toISOString() },
              atScore: { N: String(trigger.atScore) },
              totalAtFire: { N: String(total) },
              experimentTemplateId: { S: trigger.experimentTemplateId },
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          }),
        );
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') continue; // 発火済み
        throw err;
      }

      // クレーム成功 → 実験開始
      const res = await fis.send(
        new StartExperimentCommand({
          experimentTemplateId: trigger.experimentTemplateId,
          tags: { Name: `gameday-escalation-${trigger.id}`, TriggeredBy: 'score-escalator' },
        }),
      );
      const experimentId = res.experiment?.id;
      fired.push({ trigger: trigger.id, atScore: trigger.atScore, total, experimentId });
      console.log(
        JSON.stringify({
          msg: 'escalation fired',
          trigger: trigger.id,
          label: trigger.label,
          atScore: trigger.atScore,
          total,
          experimentId,
        }),
      );
    }
  }
  return { fired };
};
