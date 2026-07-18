import { useEffect, useState } from 'react';
import { canRetry, findStartCandidate } from './scoring';
import type { GamedayData } from './types';

/** dev サーバ /api/reset (GET) の状態応答 */
interface ResetStatus {
  running: boolean;
  ok?: boolean;
  tail?: string[];
}

/**
 * 運営用のゲーム進行コントロール (dev サーバ専用。App 側で import.meta.env.DEV ガード)。
 *
 * - **GameDay 開始**: CDK デプロイ後・まだ何も始まっていないとき、最初の
 *   experimentTemplateId 付きインジェクトの FIS 実験を開始する (POST /api/start)。
 *   以降の armed/impacted/recovered と採点は GameEvents の自動記録に乗る。
 * - **リトライ (周回リセット)**: 振り返りフィードバック (KPT か review) が残ったあとに
 *   出る。POST /api/reset が `npm run reset` (実験停止 → revert-drift → 状態ワイプ →
 *   gameday.json 初期化) を実行する。数分かかるため進行状況をポーリング表示し、
 *   誤爆防止に 2 段階クリックにする。
 *
 * どちらも AWS 認証済みシェルで `npm run dashboard` を起動している前提 (score 同期と同じ)。
 */
export default function GameControl({ data }: { data: GamedayData }) {
  const [busy, setBusy] = useState(false); // 開始リクエスト中
  const [startedId, setStartedId] = useState<string | null>(null); // 楽観: 開始済み実験 ID ('' = ID 不明)
  const [error, setError] = useState<string | null>(null);
  const [resetArmed, setResetArmed] = useState(false); // 2 段階クリックの 1 段目
  const [resetting, setResetting] = useState(false);
  const [resetLine, setResetLine] = useState<string | null>(null); // 進行ログの末尾行
  const [resetDone, setResetDone] = useState<boolean | null>(null); // 直近リセットの成否

  // マウント時: リセットが既に走っていれば (リロード後など) ポーリングに復帰する
  useEffect(() => {
    let cancelled = false;
    void fetch('api/reset')
      .then(async (res) => (await res.json()) as ResetStatus)
      .then((s) => {
        if (!cancelled && s.running) setResetting(true);
      })
      .catch(() => {
        /* エンドポイント不在 (静的ビルド等) は何もしない */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // リセット中は 2 秒ごとに進行状況を取りに行く
  useEffect(() => {
    if (!resetting) return;
    const timer = window.setInterval(() => {
      void fetch('api/reset')
        .then(async (res) => (await res.json()) as ResetStatus)
        .then((s) => {
          setResetLine(s.tail?.[s.tail.length - 1] ?? null);
          if (!s.running) {
            setResetting(false);
            setResetDone(s.ok ?? false);
            setStartedId(null); // 次の周回で開始ボタンを出し直す
          }
        })
        .catch(() => {
          /* 一時的な失敗は次のポーリングに任せる */
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [resetting]);

  // 1 段目クリックのまま放置されたら自動で解除する (誤爆防止の取り消し)
  useEffect(() => {
    if (!resetArmed) return;
    const t = window.setTimeout(() => setResetArmed(false), 8000);
    return () => clearTimeout(t);
  }, [resetArmed]);

  const candidate = startedId !== null ? null : findStartCandidate(data);

  const start = () => {
    if (!candidate) return;
    setBusy(true);
    setError(null);
    fetch('api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ injectId: candidate.id }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { error?: string; experimentId?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setStartedId(body.experimentId ?? '');
        setResetDone(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const retry = () => {
    if (!resetArmed) {
      setResetArmed(true);
      return;
    }
    setResetArmed(false);
    setError(null);
    setResetDone(null);
    setResetLine(null);
    fetch('api/reset', { method: 'POST' })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setResetting(true);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const showRetry = !resetting && (canRetry(data) || resetDone !== null);
  if (!candidate && startedId === null && !showRetry && !resetting) return null;

  return (
    <div className="game-control">
      {candidate && (
        <>
          {/* インジェクト名は添えず動詞を明確に (「タスク停止」等が混ざると開始/停止が紛らわしい)。
              対象は隣の注記に出す */}
          <button type="button" className="game-start" onClick={start} disabled={busy}>
            {busy ? '開始しています…' : '▶ GameDay を開始する'}
          </button>
          <span className="game-note">{`最初のインジェクト「${candidate.title}」の障害注入が始まる`}</span>
        </>
      )}
      {startedId !== null && (
        <span className="game-note">
          {`実験を開始した${startedId ? ` (${startedId})` : ''} — まもなく「実験進行中」表示に変わる`}
        </span>
      )}
      {showRetry && (
        <button
          type="button"
          className={resetArmed ? 'game-retry armed' : 'game-retry'}
          onClick={retry}
        >
          {resetArmed
            ? 'もう一度クリックで実行 (実験停止 → revert → 状態ワイプ)'
            : '⟳ リトライ (周回リセット)'}
        </button>
      )}
      {resetting && (
        <span className="game-note">
          {`周回リセット実行中 (数分かかる)… ${resetLine ?? ''}`}
        </span>
      )}
      {resetDone === true && (
        <span className="game-note">リセット完了 — canary が緑に戻るのを待って開始できる</span>
      )}
      {resetDone === false && (
        <span className="game-error">リセット失敗 — dev サーバのターミナルログを確認</span>
      )}
      {error && <span className="game-error">{error}</span>}
    </div>
  );
}
