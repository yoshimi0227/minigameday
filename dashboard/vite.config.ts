import { spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react-oxc';
import { DynamoDBClient, PutItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { FisClient, StartExperimentCommand } from '@aws-sdk/client-fis';
import { deriveFromEvents, findStartCandidate } from './src/scoring';
import { generateReview } from './review-generator';
import { collectDriftMaterial } from './drift-detector';
import { AI_FEEDBACK_AUTHOR, type GameEvent, type GamedayData, type HintReveal } from './src/types';

// ---------------------------------------------------------------------------
// gameday.json への書き込みは全てこのヘルパを通す (dev サーバ内で直列化)。
// 書き手は hintRevealApi / ackApi / gameEventsSync の 3 つ + 運営の手編集。
// プロセス内は Promise チェーンで完全に直列化し、手編集との競合は「書く直前に
// 読み直す + tmp→rename (ほぼアトミック)」で窓を最小化する。変更が無ければ書かない。
// 運用規約: ゲーム中の手編集は response/notes/feedback 等に限り、派生フィールド
// (impactStartAt など) は触らない (references/data-schema.md 参照)。
// ---------------------------------------------------------------------------
let writeQueue: Promise<unknown> = Promise.resolve();
function updateGamedayJson<T>(
  dataPath: string,
  mutate: (data: GamedayData) => { changed: boolean; result: T },
): Promise<T> {
  const task = writeQueue.then(() => {
    const data = JSON.parse(readFileSync(dataPath, 'utf8')) as GamedayData;
    const { changed, result } = mutate(data);
    if (changed) {
      const tmp = `${dataPath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
      renameSync(tmp, dataPath); // 部分書き込みをポーリングに読ませない
    }
    return result;
  });
  writeQueue = task.catch(() => undefined); // 失敗してもキューは止めない
  return task;
}

/** POST ボディの JSON を読む小さなユーティリティ (3 エンドポイント共用) */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/** 書き込み API (reveal/ack) の応答。mutate の戻り値を HTTP に写すための共通形 */
interface ApiResult {
  code: number;
  body: unknown;
}

function gamedayJsonPath(server: ViteDevServer): string {
  return join(server.config.root, 'public', 'data', 'gameday.json');
}

/**
 * dev サーバに「ヒント開示を gameday.json に追記する」書き込みエンドポイントを足すプラグイン。
 * POST /api/reveal-hint {injectId, hintId} → hintReveals[] に (重複しなければ) 追記する。
 * 開示が localStorage だけでなくイベントの永続記録になり、振り返りで集計できる。
 * dev のみ有効 (静的ビルドでは localStorage の楽観更新のみ)。
 */
function hintRevealApi(): Plugin {
  return {
    name: 'gameday-hint-reveal-api',
    configureServer(server: ViteDevServer) {
      const dataPath = gamedayJsonPath(server);
      server.middlewares.use('/api/reveal-hint', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        void readJsonBody(req)
          .then((body) => {
            const { injectId, hintId } = body;
            if (typeof injectId !== 'string' || typeof hintId !== 'string') {
              return sendJson(res, 400, { error: 'injectId と hintId が必要' });
            }
            return updateGamedayJson<ApiResult>(dataPath, (data) => {
              const inject = data.injects.find((i) => i.id === injectId);
              const hint = inject?.hints?.find((h) => h.id === hintId);
              if (!hint) {
                return {
                  changed: false,
                  result: { code: 400, body: { error: '該当するヒントが gameday.json に無い' } },
                };
              }
              data.hintReveals = data.hintReveals ?? [];
              if (!data.hintReveals.some((r) => r.hintId === hintId)) {
                const reveal: HintReveal = {
                  injectId,
                  hintId,
                  label: hint.label,
                  cost: hint.cost,
                  at: new Date().toISOString(),
                };
                data.hintReveals.push(reveal);
                return {
                  changed: true,
                  result: { code: 200, body: { ok: true, hintReveals: data.hintReveals } },
                };
              }
              return {
                changed: false,
                result: { code: 200, body: { ok: true, hintReveals: data.hintReveals } },
              };
            }).then((r) => sendJson(res, r.code, r.body));
          })
          .catch((e: unknown) =>
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) }),
          );
      });
    },
  };
}

/**
 * 「検知宣言」エンドポイント。POST /api/ack {injectId} → inject.ackAt (サーバ時刻) と
 * events[] の ACK# エントリを記録する。検知点は impactStartAt → ackAt の速さで決まる。
 *
 * ガード: 影響が観測される前 (impactStartAt が無い) の宣言は 409 で弾く。
 * armed 直後に宣言しておけば検知が必ず満点、という抜け道を防ぐ (UI 側も同じ条件で
 * ボタンを出すが、正はサーバ側のこのチェック)。宣言は最初の 1 回だけ有効 (冪等)。
 */
function ackApi(): Plugin {
  return {
    name: 'gameday-ack-api',
    configureServer(server: ViteDevServer) {
      const dataPath = gamedayJsonPath(server);
      server.middlewares.use('/api/ack', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        void readJsonBody(req)
          .then((body) => {
            const { injectId } = body;
            if (typeof injectId !== 'string') {
              return sendJson(res, 400, { error: 'injectId が必要' });
            }
            return updateGamedayJson<ApiResult>(dataPath, (data) => {
              const inject = data.injects.find((i) => i.id === injectId);
              if (!inject) {
                return { changed: false, result: { code: 400, body: { error: '該当する injectId が無い' } } };
              }
              if (!inject.impactStartAt) {
                return {
                  changed: false,
                  result: {
                    code: 409,
                    body: { error: 'まだ影響が観測されていない (canary は green)。検知宣言は影響発生後に有効' },
                  },
                };
              }
              if (inject.ackAt) {
                return { changed: false, result: { code: 200, body: { ok: true, ackAt: inject.ackAt } } };
              }
              const now = new Date().toISOString();
              inject.ackAt = now;
              data.events = data.events ?? [];
              const key = `ACK#${injectId}`;
              if (!data.events.some((e) => e.key === key)) {
                data.events.push({ key, type: 'ack', at: now, injectId });
              }
              deriveFromEvents(data); // detectionMinutes 等を即時反映 (冪等)
              return { changed: true, result: { code: 200, body: { ok: true, ackAt: now } } };
            }).then((r) => sendJson(res, r.code, r.body));
          })
          .catch((e: unknown) =>
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) }),
          );
      });
    },
  };
}

/**
 * dev サーバに「現在の合計スコアを DynamoDB (gameday-score) へ同期する」エンドポイントを足す。
 * POST /api/score {total} → DynamoDB の SCORE アイテムを更新する。これが DynamoDB Streams →
 * Lambda (score-escalator) を起動し、閾値到達で「次の障害」が自動発火する (AWS ネイティブ)。
 *
 * エスカレーションの運用スイッチ: gameday.json の escalation.enabled を SCORE アイテムの
 * escalationEnabled (BOOL) として写す。false のとき score-escalator は判定ごとスキップする
 * (scenario-03 ラウンド中に本体側の障害を出さないための切替。無ければ有効)。
 * クライアントの POST ボディではなく gameday.json を正とする (ブラウザから切れないように)。
 *
 * 認証は既定のクレデンシャルチェーン (dashboard を AWS 認証済みシェルで起動している前提)。
 * ベストエフォート: テーブルが無い / 未認証 / スタック未デプロイでも画面は壊さない (200 で返す)。
 * dev のみ有効 (静的ビルドにこのエンドポイントは無い)。テーブル名は CDK 側の固定名と合わせる。
 */
function scoreSyncApi(): Plugin {
  const tableName = process.env.GAMEDAY_SCORE_TABLE ?? 'gameday-score';
  // dashboard 起動時のリージョン。未設定なら SDK の既定解決に任せる。
  const ddb = new DynamoDBClient({});
  return {
    name: 'gameday-score-sync-api',
    configureServer(server: ViteDevServer) {
      const dataPath = gamedayJsonPath(server);
      server.middlewares.use('/api/score', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        void readJsonBody(req)
          .then((body) => {
            const total = Number(body.total);
            if (!Number.isFinite(total)) {
              return sendJson(res, 400, { error: 'total (number) が必要' });
            }
            // 読み取りも直列化キューを通す (手編集の tmp→rename と競合させない)
            return updateGamedayJson(dataPath, (data) => ({
              changed: false,
              result: data.escalation?.enabled ?? true,
            }))
              .then((escalationEnabled) =>
                ddb.send(
                  new PutItemCommand({
                    TableName: tableName,
                    Item: {
                      pk: { S: 'SCORE' },
                      total: { N: String(total) },
                      updatedAt: { S: new Date().toISOString() },
                      escalationEnabled: { BOOL: escalationEnabled },
                    },
                  }),
                ),
              )
              .then(() => sendJson(res, 200, { ok: true, synced: true, total }))
              .catch((e: unknown) => {
                // ベストエフォート: 同期失敗でも 200 (ダッシュボードの表示は止めない)
                sendJson(res, 200, {
                  ok: false,
                  synced: false,
                  error: e instanceof Error ? e.message : String(e),
                });
              });
          })
          .catch(() => sendJson(res, 400, { error: 'invalid json' }));
      });
    },
  };
}

/**
 * AI 講評の生成エンドポイント。POST /api/review → まず `cdk drift` を子プロセスで実行
 * (collectDriftMaterial。宣言されていない手動変更 = 想定外の手作業の検知材料。240 秒で
 * 打ち切り) し、gameday.json の実測データと合わせて Bedrock (Converse API) で
 * LLM を呼び、KPT 形式の講評を feedback[] に書き込む (author='AI 講評'。KPT ボードに
 * 人間のフィードバックと並んで出る)。drift はベストエフォート (未デプロイ・未認証は
 * UNAVAILABLE として材料に含め、講評自体は止めない)。
 * 再生成は AI 講評エントリだけを入れ替える (人間の KPT は触らない)。
 * 生成は数分かかる (drift 1〜3 分 + LLM) ため直列化し、生成中の再実行は 409 で弾く。
 * 認証: Bedrock は AWS_BEARER_TOKEN_BEDROCK か既定チェーン。cdk drift は起動シェルの認証。
 */
function reviewApi(): Plugin {
  let generating = false;
  return {
    name: 'gameday-review-api',
    configureServer(server: ViteDevServer) {
      const dataPath = gamedayJsonPath(server);
      // cdk drift はプロジェクトルートで実行する (dev サーバの root は dashboard/)
      const projectRoot = join(server.config.root, '..');
      server.middlewares.use('/api/review', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (generating) return sendJson(res, 409, { error: '講評を生成中。完了を待ってから再実行する' });
        generating = true;
        // 材料の読み取りも updateGamedayJson (直列化キュー) を通す (changed: false = 読むだけ)。
        // キュー外で readFileSync すると書き込みの tmp→rename と競合し Windows で EBUSY 等に
        // なり得るうえ、同期例外だと .finally に届かず generating が立ちっぱなしになる。
        void updateGamedayJson(dataPath, (data) => ({ changed: false, result: data }))
          .then(async (data) => generateReview(data, await collectDriftMaterial(projectRoot)))
          .then((items) =>
            updateGamedayJson(dataPath, (d) => {
              const human = (d.feedback ?? []).filter((f) => f.author !== AI_FEEDBACK_AUTHOR);
              d.feedback = [...human, ...items];
              return { changed: true, result: items.length };
            }),
          )
          .then((count) => sendJson(res, 200, { ok: true, count }))
          .catch((e: unknown) =>
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) }),
          )
          .finally(() => {
            generating = false;
          });
      });
    },
  };
}

/**
 * 「GameDay 開始」エンドポイント。POST /api/start {injectId} → 対象インジェクトの
 * FIS 実験を開始する (fis:StartExperiment)。CDK デプロイ後の 1 発目を画面から叩けるようにする。
 *
 * ガード: findStartCandidate (scoring.ts) で「まだ何も始まっていない + 対象が一致」を
 * サーバ側でも確認する (二重クリック・古い画面からの誤発火を 409 で弾く)。
 * 開始後の記録 (armed/impacted/採点) は GameEvents の自動記録が拾うので、ここでは
 * gameday.json に何も書かない。認証は score 同期と同じ既定クレデンシャルチェーン。
 */
function gameStartApi(): Plugin {
  const fis = new FisClient({});
  return {
    name: 'gameday-start-api',
    configureServer(server: ViteDevServer) {
      const dataPath = gamedayJsonPath(server);
      server.middlewares.use('/api/start', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        void readJsonBody(req)
          .then((body) => {
            const { injectId } = body;
            if (typeof injectId !== 'string') {
              return sendJson(res, 400, { error: 'injectId が必要' });
            }
            // 読み取りも直列化キューを通す (手編集の tmp→rename と競合させない)
            return updateGamedayJson(dataPath, (data) => ({
              changed: false,
              result: findStartCandidate(data),
            })).then(async (candidate) => {
              if (!candidate) {
                return sendJson(res, 409, {
                  error: '開始できない (既に開始済みか、experimentTemplateId 付きインジェクトが無い)',
                });
              }
              if (candidate.id !== injectId || !candidate.experimentTemplateId) {
                return sendJson(res, 409, {
                  error: `開始対象は ${candidate.id}。画面を更新して再実行する`,
                });
              }
              try {
                const out = await fis.send(
                  new StartExperimentCommand({
                    experimentTemplateId: candidate.experimentTemplateId,
                  }),
                );
                sendJson(res, 200, { ok: true, experimentId: out.experiment?.id });
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                sendJson(res, 500, {
                  error: `実験を開始できない: ${msg} (スタック未デプロイ / 未認証シェル?)`,
                });
              }
            });
          })
          .catch(() => sendJson(res, 400, { error: 'invalid json' }));
      });
    },
  };
}

/**
 * 「リトライ (周回リセット)」エンドポイント。POST /api/reset → `npm run reset`
 * (実験停止 → revert-drift デプロイ → gameday-score ワイプ → gameday.json 初期化) を
 * 子プロセスで実行する。数分かかるので 202 で受け付け、GET /api/reset が進行状況を返す
 * (running / ok / tail = ログ末尾)。同時実行は 409。コマンドは固定でリクエスト内容を
 * 一切混ぜない (dev 専用エンドポイントだが念のため)。
 */
function resetApi(): Plugin {
  const state: { running: boolean; ok?: boolean; finishedAt?: string } = { running: false };
  let tail: string[] = [];
  return {
    name: 'gameday-reset-api',
    configureServer(server: ViteDevServer) {
      // dev サーバの root は dashboard/ なのでプロジェクトルートは 1 つ上
      const projectRoot = join(server.config.root, '..');
      server.middlewares.use('/api/reset', (req, res) => {
        if (req.method === 'GET') {
          return sendJson(res, 200, { ...state, tail: tail.slice(-5) });
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (state.running) return sendJson(res, 409, { error: '周回リセットを実行中' });

        state.running = true;
        state.ok = undefined;
        state.finishedAt = undefined;
        tail = [];
        // Windows では npm が npm.cmd のため shell 経由で起動する (reset script の runCli と同じ)
        const child = spawn('npm', ['run', 'reset'], { cwd: projectRoot, shell: true });
        const onChunk = (chunk: Buffer) => {
          tail.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
          tail = tail.slice(-30);
        };
        child.stdout?.on('data', onChunk);
        child.stderr?.on('data', onChunk);
        child.on('error', (e) => {
          tail.push(String(e));
          state.running = false;
          state.ok = false;
          state.finishedAt = new Date().toISOString();
        });
        child.on('close', (code) => {
          state.running = false;
          state.ok = code === 0;
          state.finishedAt = new Date().toISOString();
          console.log(`[gameday] 周回リセット終了 (exit ${code})`);
        });
        sendJson(res, 202, { started: true });
      });
    },
  };
}

/** DynamoDB の EVENT# アイテム → GameEvent。想定外の形は捨てる (null) */
function toGameEvent(raw: Record<string, { S?: string } | undefined>): GameEvent | null {
  const key = raw.pk?.S;
  const at = raw.at?.S;
  const type = raw.type?.S;
  if (!key || !at) return null;
  if (type === 'alarm') {
    const state = raw.state?.S;
    if (state !== 'ALARM' && state !== 'OK') return null;
    return { key, type, at, alarmName: raw.alarmName?.S, state, reason: raw.reason?.S };
  }
  if (type === 'experiment') {
    return {
      key,
      type,
      at,
      experimentId: raw.experimentId?.S,
      experimentTemplateId: raw.experimentTemplateId?.S,
      status: raw.status?.S,
    };
  }
  return null;
}

/**
 * ゲームイベント同期。DynamoDB (gameday-score) の EVENT# アイテムを 5 秒間隔でポーリングし、
 * gameday.json の events[] にマージ → deriveFromEvents で inject の派生フィールド
 * (armed/impacted/recovered、検知・復旧時刻) を再計算する。これで
 * 「FIS 実験開始 → 障害 → canary ALARM → 復旧 OK」が人手なしで画面と採点に反映される。
 *
 * ベストエフォート: 未認証・テーブル無しでもエラーを 1 回ログするだけで画面は壊さない。
 * テーブルは小さい (1 ゲームで数十アイテム) ので Scan で十分。
 */
function gameEventsSync(): Plugin {
  const tableName = process.env.GAMEDAY_SCORE_TABLE ?? 'gameday-score';
  const ddb = new DynamoDBClient({});
  const SYNC_MS = 5000;
  let lastError = '';
  return {
    name: 'gameday-events-sync',
    configureServer(server: ViteDevServer) {
      const dataPath = gamedayJsonPath(server);
      const tick = async () => {
        try {
          const items: Record<string, { S?: string }>[] = [];
          let startKey: Record<string, { S?: string }> | undefined;
          do {
            const page = await ddb.send(
              new ScanCommand({
                TableName: tableName,
                FilterExpression: 'begins_with(pk, :prefix)',
                ExpressionAttributeValues: { ':prefix': { S: 'EVENT#' } },
                ExclusiveStartKey: startKey as never,
              }),
            );
            items.push(...((page.Items ?? []) as Record<string, { S?: string }>[]));
            startKey = page.LastEvaluatedKey as never;
          } while (startKey);
          const incoming = items
            .map(toGameEvent)
            .filter((e): e is GameEvent => e !== null);
          await updateGamedayJson(dataPath, (data) => {
            let changed = false;
            const known = new Set((data.events ?? []).map((e) => e.key));
            const fresh = incoming.filter((e) => !known.has(e.key));
            if (fresh.length > 0) {
              data.events = [...(data.events ?? []), ...fresh].sort(
                (a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key),
              );
              changed = true;
            }
            // イベントが無くても導出は回す (運営の手書きフォールバックも数秒で反映される)
            if (deriveFromEvents(data)) changed = true;
            return { changed, result: undefined };
          });
          if (lastError) {
            console.log('[gameday] events 同期が復帰した');
            lastError = '';
          }
        } catch (e) {
          // ベストエフォート: 同じエラーの連呼はしない
          const msg = e instanceof Error ? e.message : String(e);
          if (msg !== lastError) {
            console.error(`[gameday] events 同期失敗 (継続します): ${msg}`);
            lastError = msg;
          }
        }
      };
      void tick();
      const timer = setInterval(() => void tick(), SYNC_MS);
      server.httpServer?.on('close', () => clearInterval(timer));
    },
  };
}

// dashboard 専用の Vite 設定。`vp dev dashboard` / `vp build dashboard` はこの
// ディレクトリを root として実行されるため、ここに置く (ルートの vite.config.ts は
// CDK プロジェクト全体の test / lint 設定を持つ)。
export default defineConfig({
  plugins: [
    react(),
    hintRevealApi(),
    ackApi(),
    scoreSyncApi(),
    gameEventsSync(),
    reviewApi(),
    gameStartApi(),
    resetApi(),
  ],
});
