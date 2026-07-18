import { useState } from 'react';

/**
 * AI 講評の生成ボタン (dev サーバ専用)。POST /api/review が Bedrock 経由で LLM を呼び、
 * KPT 形式の講評を feedback[] (author='AI 講評') に書き込む → ポーリングで数秒後に
 * KPT ボードへ並ぶ。再生成は AI 講評エントリだけを入れ替える (人間の KPT は残る)。
 * 静的ビルドにはエンドポイントが無いので App 側で import.meta.env.DEV でガードする。
 */
export default function ReviewControl({ hasAiFeedback }: { hasAiFeedback: boolean }) {
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
        {busy
          ? 'AI 講評を生成中… (drift 検出込みで数分)'
          : hasAiFeedback
            ? 'AI 講評 (KPT) を再生成'
            : 'AI 講評を KPT で生成'}
      </button>
    </div>
  );
}
