// AI 講評の生成 (dev サーバ専用 — ブラウザには載せない)。
// Amazon Bedrock の Converse API 経由で LLM を呼び、gameday.json の実測データ
// (events タイムライン・検知/復旧分数・ヒント消費・採点) から Review スキーマの講評を作る。
//
// モデルは Converse API で呼べるものなら何でもよい (モデル非依存)。既定は Amazon Nova Lite —
// このアカウントは Anthropic モデル (Claude) が全世代アクセス不可のため (CLAUDE.md 検証済みメモ
// 2026-07-18)。Claude が解禁されたら GAMEDAY_REVIEW_MODEL に推論プロファイル ID を渡すだけで戻せる。
//
// 認証は既定の AWS 認証チェーン (または AWS_BEARER_TOKEN_BEDROCK)。
// リージョン/モデルは GAMEDAY_BEDROCK_REGION / GAMEDAY_REVIEW_MODEL で上書きできる。

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { GamedayData, Review, ReviewInject } from './src/types';

// 既定は APAC クロスリージョン推論プロファイルの Nova Lite (東京から呼べる・低コスト)
const MODEL = process.env.GAMEDAY_REVIEW_MODEL ?? 'apac.amazon.nova-lite-v1:0';
const REGION = process.env.GAMEDAY_BEDROCK_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-1';

// 出力してほしい JSON の形。Converse API には Anthropic の output_config (json_schema 強制) が
// 無いので、スキーマをプロンプトに埋めて「JSON のみ出力」を指示し、受信側で検証する。
// generatedAt はサーバ時刻で付与するのでモデルには求めない。
const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overall', 'injects'],
  properties: {
    overall: { type: 'string', description: 'ゲーム全体の総評 (2〜4 文)' },
    injects: {
      type: 'array',
      description: '実績のあるインジェクトごとの講評',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['injectId', 'headline', 'commentary', 'wentWell', 'toImprove'],
        properties: {
          injectId: { type: 'string', description: 'gameday.json の injects[].id と一致させる' },
          headline: { type: 'string', description: '一言の見出し (例: 静観の判断が正解)' },
          commentary: { type: 'string', description: '実測タイムラインを織り込んだ講評 2〜4 文' },
          wentWell: { type: 'array', items: { type: 'string' } },
          toImprove: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

// 採点ルーブリック・ラウンドの前提は gameday-dashboard スキルの記載と揃えている
const SYSTEM_PROMPT = `あなたはミニ GameDay (AWS 障害対応ワークショップ) の講評者。参加者の対応を機械記録の実測データに基づいて講評する。

採点ルーブリック (各インジェクト 100 点。既定値 — データに scoring セクションがあれば数値はそちらを正とする):
- 検知 40 点: 影響開始 → 検知宣言 (ackAt) の速さ。2 分以内満点、15 分で 0 に線形減衰
- 対応 40 点: 影響開始 → 復旧 (recoveredAt) の MTTR。5 分以内満点、30 分で 0。自己回復する障害では「静観」の判断も満点になりうる
- 伝達・記録 20 点: 状況宣言・記録の質 (commsScore に手動採点済み)

前提:
- R1 観察ラウンド = 自己回復する障害 (静観・判断の練習)。R2 対応ラウンド = 自己回復しない障害 (人が直すまで復旧しない。MTTR が対応速度の実測値)
- 減点ではなく加点で考える。「壊れてもシステムが守り、人が正しく観測して高得点」が理想形
- events[] は機械記録 (FIS 実験開始 running / canary ALARM=影響開始 / OK=復旧 / ack=検知宣言) で最も客観的な一次資料。タイムラインと分数は必ずここからの実測値で語る
- hintReveals はヒント開示の記録 (開示コストは実効スコアから減算済み)。早い段階での具体手順ヒントの購入は自力解決できなかった目安として講評に織り込む

出力の指針:
- overall: ゲーム全体の総評 2〜4 文
- injects: 実績のあるインジェクトのみ (実験・影響・採点のいずれの記録も無い pending は含めない)。headline は一言、commentary は実測タイムライン・ヒント消費・採点内訳を織り込んだ 2〜4 文。wentWell / toImprove は各 0〜3 個 (無ければ空配列)
- 文体: 簡潔な常体 (だ・である)。数値は与えられた実測値をそのまま使い、推測で補わない

出力形式 (厳守):
- 次の JSON Schema に厳密に従った JSON オブジェクト**のみ**を出力する
- コードフェンス (\`\`\`)・前置き・後書き・説明文は一切付けない
${JSON.stringify(REVIEW_OUTPUT_SCHEMA)}`;

/** モデルがコードフェンスで包んできた場合に剥がす (Nova 等はプロンプト指示だけだと稀に付ける) */
function stripCodeFence(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : text.trim();
}

/** gameday.json の実測データから講評 (Review) を生成する。失敗時は throw。 */
export async function generateReview(data: GamedayData): Promise<Review> {
  // systems (構成図) は講評の材料として過剰なので落とし、実測系だけ渡す
  const material = {
    event: data.event,
    rounds: data.rounds,
    scoring: data.scoring,
    injects: data.injects,
    events: data.events,
    hintReveals: data.hintReveals,
    feedback: data.feedback,
  };

  const client = new BedrockRuntimeClient({ region: REGION });
  const response = await client.send(
    new ConverseCommand({
      modelId: MODEL,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [
        {
          role: 'user',
          content: [
            { text: `今回の GameDay の記録データ (gameday.json) を講評せよ。\n\n${JSON.stringify(material)}` },
          ],
        },
      ],
      // 講評 JSON は数千トークンで収まる。Nova Lite の出力上限にも収まる値
      inferenceConfig: { maxTokens: 4096 },
    }),
  );

  if (response.stopReason === 'max_tokens') {
    throw new Error('講評が出力上限で途切れた (stopReason: max_tokens)。インジェクト数を絞るか maxTokens を上げる');
  }
  const text = response.output?.message?.content?.find((b) => 'text' in b)?.text;
  if (!text) {
    throw new Error(`講評テキストが返らなかった (stopReason: ${response.stopReason})`);
  }
  const parsed = JSON.parse(stripCodeFence(text)) as { overall: string; injects: ReviewInject[] };
  if (typeof parsed.overall !== 'string' || !Array.isArray(parsed.injects)) {
    throw new Error('講評 JSON が Review スキーマに合わない');
  }
  return { generatedAt: new Date().toISOString(), overall: parsed.overall, injects: parsed.injects };
}
