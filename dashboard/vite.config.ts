import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react-oxc';

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

// dashboard 専用の Vite 設定。`vp dev dashboard` / `vp build dashboard` はこの
// ディレクトリを root として実行されるため、ここに置く (ルートの vite.config.ts は
// CDK プロジェクト全体の test / lint 設定を持つ)。
export default defineConfig({
  plugins: [react(), hintRevealApi()],
});
