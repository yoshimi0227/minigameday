import { useState } from 'react';

/**
 * AI 講評の生成ボタン (dev サーバ専用)。POST /api/review が Bedrock 経由で Claude を呼び、
 * gameday.json の review に書き込む → ポーリングで数秒後に ReviewBoard として表示される。
 * 静的ビルドにはエンドポイントが無いので App 側で import.meta.env.DEV でガードする。
 */
export default function ReviewControl({ hasReview }: { hasReview: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = () => {
    setBusy(true);
    setError(null);
    fetch('api/review', { method: 'POST' })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="review-control">
      {error && <span className="review-error">{`生成に失敗: ${error}`}</span>}
      <button type="button" className="review-generate" onClick={generate} disabled={busy}>
        {busy ? 'AI 講評を生成中… (1〜2 分)' : hasReview ? 'AI 講評を再生成' : 'AI 講評を生成'}
      </button>
    </div>
  );
}
