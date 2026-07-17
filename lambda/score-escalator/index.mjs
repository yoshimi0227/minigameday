// スコアエスカレーション Lambda。
// DynamoDB (gameday-score) の SCORE アイテムが更新されるたびに Streams で起動し、
// 実効スコアが閾値 (atScore) に達したトリガーがあれば FIS 実験を自動で開始する
// (= 「スコアが一定以上たまったら新たな障害が発生する」仕組みの発火点)。
//
// 冪等性: 各トリガーは 1 回だけ発火させたい。スコアは閾値を超えたまま何度も更新され得るので、
//   FIRED#<id> アイテムを attribute_not_exists で条件付き PutItem して「先勝ち」でクレームし、
//   クレームできたときだけ StartExperiment する。既にクレーム済みなら黙ってスキップ。
//   FIRED# アイテムの書き込みは pk!='SCORE' なのでイベントソースのフィルタで弾かれ、再帰しない。
//   StartExperiment が失敗したらクレームを条件付き Delete で返却してから throw する —
//   返却しないと「実験は始まっていないのにトリガーだけ永久消費」になり、リトライが必ず
//   ConditionalCheckFailed で空振りする (発火の取りこぼし)。
//
// 有効/無効: SCORE アイテムの escalationEnabled (BOOL) が false のときは判定ごとスキップする。
//   scenario-03 (legacy) のラウンド中など「今は次の障害を出したくない」局面で、運営が
//   gameday.json の escalation.enabled を false にする → dev サーバが SCORE に写す。
//   属性が無いときは有効 (後方互換)。再度有効化した後の最初のスコア更新で改めて判定される。
//
// バンドル: aws-cdk-lib/aws-lambda-nodejs (esbuild) が @aws-sdk/* を同梱する
//   (ランタイム同梱 SDK に client-fis がある保証がないため、AWS 推奨どおり明示バンドル)。

import { DynamoDBClient, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
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

    // 運営による一時停止 (gameday.json の escalation.enabled=false → dev サーバが写す)
    if (image.escalationEnabled?.BOOL === false) {
      console.log(JSON.stringify({ msg: 'escalation disabled, skipping', total }));
      continue;
    }

    for (const trigger of TRIGGERS) {
      if (total < trigger.atScore) continue;

      // 冪等クレーム: 既に発火済みなら ConditionalCheckFailed で抜ける
      const firedAt = new Date().toISOString();
      try {
        await ddb.send(
          new PutItemCommand({
            TableName: TABLE_NAME,
            Item: {
              pk: { S: `FIRED#${trigger.id}` },
              firedAt: { S: firedAt },
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

      // クレーム成功 → 実験開始。失敗したら自分のクレームだけを返却してから throw
      // (firedAt 一致の条件付き Delete = 並行して張り直された他のクレームは消さない)。
      // throw で Streams のリトライに乗り、次の試行が改めてクレームからやり直せる。
      let res;
      try {
        res = await fis.send(
          new StartExperimentCommand({
            experimentTemplateId: trigger.experimentTemplateId,
            tags: { Name: `gameday-escalation-${trigger.id}`, TriggeredBy: 'score-escalator' },
          }),
        );
      } catch (err) {
        try {
          await ddb.send(
            new DeleteItemCommand({
              TableName: TABLE_NAME,
              Key: { pk: { S: `FIRED#${trigger.id}` } },
              ConditionExpression: 'firedAt = :firedAt',
              ExpressionAttributeValues: { ':firedAt': { S: firedAt } },
            }),
          );
        } catch (rollbackErr) {
          // 返却失敗 (他クレームに置き換わった等) は握りつぶし、元エラーを優先して投げる
          if (rollbackErr?.name !== 'ConditionalCheckFailedException') {
            console.error(JSON.stringify({ msg: 'claim rollback failed', trigger: trigger.id }));
          }
        }
        throw err;
      }
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
