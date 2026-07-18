// AI 講評の生成 (dev サーバ専用 — ブラウザには載せない)。
// Amazon Bedrock の Converse API 経由で LLM を呼び、gameday.json の実測データ
// (events タイムライン・検知/復旧分数・ヒント消費・採点) + `cdk drift` の実行結果
// (drift-detector.ts。宣言されていない手動変更 = 想定外の手作業の検知) から
// KPT 形式の講評を作る。
// 生成物は feedback[] に author='AI 講評' で書き込まれ、KPT ボードに人間の
// フィードバックと並んで表示される (独立した review セクションは 2026-07-18 に廃止)。
//
// モデルは Converse API で呼べるものなら何でもよい (モデル非依存)。既定は Amazon Nova Lite —
// このアカウントは Anthropic モデル (Claude) が全世代アクセス不可のため (CLAUDE.md 検証済みメモ
// 2026-07-18)。Claude が解禁されたら GAMEDAY_REVIEW_MODEL に推論プロファイル ID を渡すだけで戻せる。
//
// 認証は既定の AWS 認証チェーン (または AWS_BEARER_TOKEN_BEDROCK)。
// リージョン/モデルは GAMEDAY_BEDROCK_REGION / GAMEDAY_REVIEW_MODEL で上書きできる。

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { AI_FEEDBACK_AUTHOR, type Feedback, type GamedayData } from './src/types';
import { autoScoreBreakdown, DEFAULT_SCORING } from './src/scoring';
import type { DriftMaterial } from './drift-detector';

// 既定は APAC クロスリージョン推論プロファイルの Nova Lite (東京から呼べる・低コスト)
const MODEL = process.env.GAMEDAY_REVIEW_MODEL ?? 'apac.amazon.nova-lite-v1:0';
const REGION = process.env.GAMEDAY_BEDROCK_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-1';

// 出力してほしい JSON の形。Converse API には Anthropic の output_config (json_schema 強制) が
// 無いので、スキーマをプロンプトに埋めて「JSON のみ出力」を指示し、受信側で検証する。
const KPT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      description: 'KPT 形式の講評 (計 3〜8 個。実測データに基づくものだけ)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'comment'],
        properties: {
          type: {
            type: 'string',
            enum: ['keep', 'problem', 'try'],
            description: 'keep=続けたい良い動き / problem=課題 / try=次に試すこと',
          },
          comment: {
            type: 'string',
            description: '講評 1〜3 文。実測タイムライン・分数・採点・ヒント消費を織り込む',
          },
          scenarioId: {
            type: 'string',
            description: '特定インジェクトの講評なら injects[].scenarioId を。全体の話なら省略',
          },
        },
      },
    },
  },
} as const;

// 採点ルーブリック・ラウンドの前提は gameday-dashboard スキルの記載と揃えている
const SYSTEM_PROMPT = `あなたはミニ GameDay (AWS 障害対応ワークショップ) の講評者。参加者の対応を機械記録の実測データに基づいて KPT (Keep / Problem / Try) 形式で講評する。

採点ルーブリック (各インジェクト 100 点。既定値 — データに scoring セクションがあれば数値はそちらを正とする):
- 検知 40 点: 影響開始 → 検知宣言 (ackAt) の速さ。2 分以内満点、15 分で 0 に線形減衰
- 対応 40 点: 影響開始 → 復旧 (recoveredAt) の MTTR。5 分以内満点、30 分で 0。自己回復する障害では「静観」の判断も満点になりうる
- 伝達・記録 20 点: 状況宣言・記録の質 (commsScore に手動採点済み)

前提:
- 自己回復する障害 (観察型) は静観・判断の練習。自己回復しない障害 (対応型) は人が直すまで復旧しない (MTTR が対応速度の実測値)
- 減点ではなく加点で考える。「壊れてもシステムが守り、人が正しく観測して高得点」が理想形
- events[] は機械記録 (FIS 実験開始 running / canary ALARM=影響開始 / OK=復旧 / ack=検知宣言) で最も客観的な一次資料。タイムラインと分数は必ずここからの実測値で語る
- events[] が空 = まだ何も実施されていない。検知・復旧・タイムライン・採点についての講評を捏造しない (材料が drift や feedback だけなら、その範囲に限って講評する)
- injects[].instruction・hints はシナリオの筋書き・教材であって、実施された事実ではない。「何が行われたか」は events[]・response・hintReveals・drift だけから判断する
- hintReveals はヒント開示の記録 (開示コストは実効スコアから減算済み)。早い段階での具体手順ヒントの購入は自力解決できなかった目安として講評に織り込む
- feedback[] に既にある人間のフィードバックと同じ内容を繰り返さない (別視点・実測の裏付けを加えるのは良い)
- drift は講評直前に実行した \`cdk drift\` (CDK CLI) の生出力 (IaC の期待状態 vs 実リソースの実測差分。スタックごとに差分のあるリソースの一覧、無ければ "No drift detected" が出る)。差分として出たリソースはコードに還元されていない手動変更 (コンソール操作等) の痕跡:
  - injects[].response・notes・feedback のどこにも宣言されていない手動変更が drift にあれば「想定外の手作業」として problem に挙げる (リソース名・差分内容を添えて事実ベースで)
  - 宣言済みの手動対応が drift に残っている場合は、CDK へ還元する具体策 (\`cdk deploy --revert-drift\` で巻き戻す / CDK コードを直して deploy) を try に出す
  - "No drift detected" は「検出可能な範囲で差分なし」(ドリフト非対応のリソースタイプもあるため変更ゼロの証明ではない)。drift.status が UNAVAILABLE のときは drift を根拠にした講評をしない (note に理由がある)

出力の指針:
- keep: 実測に裏付けられた良い動き (例: 影響 N 分での検知宣言、正しい観測起点)
- problem: 実測が示す課題 (例: 検知 N 分は減衰ゼロ圏、ヒント依存)。事実ベースで責めない
- try: 次の周回・本番でそのまま実行できる具体的な改善 (コマンド・手順・観測の張り方)
- 実績のあるインジェクトだけを対象にする。合計 3〜8 個。文体は簡潔な常体 (だ・である)。数値は与えられた実測値をそのまま使い、推測で補わない
- injects[].computedScore は scoring.ts が計算した確定の自動採点内訳 (detection/recovery/comms の点)。点数はこの値をそのまま引用し、減衰カーブから自分で計算し直さない (comms が無いのは運営が未採点なだけ — 0 点と書かない)

出力形式 (厳守):
- 次の JSON Schema に厳密に従った JSON オブジェクト**のみ**を出力する
- コードフェンス (\`\`\`)・前置き・後書き・説明文は一切付けない
${JSON.stringify(KPT_OUTPUT_SCHEMA)}`;

/** モデルがコードフェンスで包んできた場合に剥がす (Nova 等はプロンプト指示だけだと稀に付ける) */
function stripCodeFence(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : text.trim();
}

const KPT_TYPES = new Set(['keep', 'problem', 'try']);

/**
 * gameday.json の実測データ + `cdk drift` の結果から KPT 形式の講評 (feedback[] へ追記する
 * エントリ群) を生成する。drift は呼び出し側 (reviewApi) が collectDriftMaterial で集める —
 * 取れなかった場合も UNAVAILABLE として渡し、欠落と「差分なし」を LLM に混同させない。
 * author は AI_FEEDBACK_AUTHOR 固定 (再生成時の入れ替えキー)。失敗時は throw。
 */
export async function generateReview(
  data: GamedayData,
  drift?: DriftMaterial,
): Promise<Feedback[]> {
  // systems (構成図) は講評の材料として過剰なので落とし、実測系だけ渡す。
  // 採点は LLM に計算させず scoring.ts の確定値 (computedScore) を添える
  // (Nova Lite は減衰カーブの計算を誤る — 2026-07-18 リハーサルで実測)。
  const scoringConfig = data.scoring ?? DEFAULT_SCORING;
  const material = {
    event: data.event,
    rounds: data.rounds,
    scoring: data.scoring,
    injects: data.injects.map((inject) => {
      const breakdown = autoScoreBreakdown(inject, scoringConfig);
      if (!breakdown) return inject;
      return {
        ...inject,
        computedScore:
          inject.commsScore !== undefined
            ? breakdown
            : { detection: breakdown.detection, recovery: breakdown.recovery },
      };
    }),
    events: data.events,
    hintReveals: data.hintReveals,
    // 人間の KPT は「重複を避ける」材料として渡す (AI 自身の前回生成分は除く)
    feedback: (data.feedback ?? []).filter((f) => f.author !== AI_FEEDBACK_AUTHOR),
    // 講評直前に実行した `cdk drift` の結果 (宣言されていない手動変更の検知材料)
    drift,
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
            { text: `今回の GameDay の記録データ (gameday.json + ドリフト検出結果) を KPT 形式で講評せよ。\n\n${JSON.stringify(material)}` },
          ],
        },
      ],
      // KPT 数個の JSON は数千トークンで収まる。Nova Lite の出力上限にも収まる値
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
  const parsed = JSON.parse(stripCodeFence(text)) as { items?: Feedback[] };
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error('講評 JSON が KPT スキーマに合わない (items が無い/空)');
  }
  const invalid = parsed.items.find(
    (i) => !KPT_TYPES.has(i.type) || typeof i.comment !== 'string' || i.comment.length === 0,
  );
  if (invalid) {
    throw new Error(`講評 JSON に不正なエントリがある: ${JSON.stringify(invalid)}`);
  }
  return parsed.items.map((i) => ({
    type: i.type,
    comment: i.comment,
    ...(typeof i.scenarioId === 'string' && i.scenarioId ? { scenarioId: i.scenarioId } : {}),
    author: AI_FEEDBACK_AUTHOR,
  }));
}
