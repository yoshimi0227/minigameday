import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react-oxc';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

/**
 * dev サーバに「ヒント開示を gameday.json に追記する」書き込みエンドポイントを足すプラグイン。
 * POST /api/reveal-hint {injectId, hintId} → public/data/gameday.json の hintReveals[] に
 * (重複しなければ) 追記する。これで開示が localStorage だけでなくイベントの永続記録になり、
 * 振り返りで「どのヒントに何ポイント使ったか」を集計できる。
 * dev のみ有効 (静的ビルドにはこのエンドポイントは無く、その場合はクライアントの
 * localStorage 楽観更新のみ)。書き込み直前に読み直すので、運営の手編集となるべく競合しない。
 */
function hintRevealApi(): Plugin {
  return {
    name: 'gameday-hint-reveal-api',
    configureServer(server: ViteDevServer) {
      const dataPath = join(server.config.root, 'public', 'data', 'gameday.json');
      server.middlewares.use('/api/reveal-hint', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('method not allowed');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const fail = (code: number, msg: string) => {
            res.statusCode = code;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: msg }));
          };
          try {
            const { injectId, hintId } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            if (typeof injectId !== 'string' || typeof hintId !== 'string') {
              return fail(400, 'injectId と hintId が必要');
            }
            // 書き込み直前に読み直す (手編集との競合窓を最小化)
            const data = JSON.parse(readFileSync(dataPath, 'utf8'));
            const inject = (data.injects ?? []).find((i: { id: string }) => i.id === injectId);
            const hint = inject?.hints?.find((h: { id: string }) => h.id === hintId);
            if (!hint) return fail(400, '該当するヒントが gameday.json に無い');

            data.hintReveals = data.hintReveals ?? [];
            const already = data.hintReveals.find((r: { hintId: string }) => r.hintId === hintId);
            if (!already) {
              data.hintReveals.push({
                injectId,
                hintId,
                label: hint.label,
                cost: hint.cost,
                at: new Date().toISOString(),
              });
              writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
            }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, hintReveals: data.hintReveals }));
          } catch (e) {
            fail(500, e instanceof Error ? e.message : String(e));
          }
        });
      });
    },
  };
}

/**
 * dev サーバに「現在の合計スコアを DynamoDB (gameday-score) へ同期する」エンドポイントを足す。
 * POST /api/score {total} → DynamoDB の SCORE アイテムを更新する。これが DynamoDB Streams →
 * Lambda (score-escalator) を起動し、閾値到達で「次の障害」が自動発火する (AWS ネイティブ)。
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
      server.middlewares.use('/api/score', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('method not allowed');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          res.setHeader('content-type', 'application/json');
          let total: number;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            total = Number(body.total);
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'invalid json' }));
            return;
          }
          if (!Number.isFinite(total)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'total (number) が必要' }));
            return;
          }
          ddb
            .send(
              new PutItemCommand({
                TableName: tableName,
                Item: {
                  pk: { S: 'SCORE' },
                  total: { N: String(total) },
                  updatedAt: { S: new Date().toISOString() },
                },
              }),
            )
            .then(() => res.end(JSON.stringify({ ok: true, synced: true, total })))
            .catch((e: unknown) => {
              // ベストエフォート: 同期失敗でも 200 (ダッシュボードの表示は止めない)
              res.end(
                JSON.stringify({
                  ok: false,
                  synced: false,
                  error: e instanceof Error ? e.message : String(e),
                }),
              );
            });
        });
      });
    },
  };
}

// dashboard 専用の Vite 設定。`vp dev dashboard` / `vp build dashboard` はこの
// ディレクトリを root として実行されるため、ここに置く (ルートの vite.config.ts は
// CDK プロジェクト全体の test / lint 設定を持つ)。
export default defineConfig({
  plugins: [react(), hintRevealApi(), scoreSyncApi()],
});
