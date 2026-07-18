import { useCallback, useEffect, useState } from 'react';
import Tiles from './Tiles';
import Architecture from './Architecture';
import AckBanner from './AckBanner';
import ScoreTable from './ScoreTable';
import TimeChart, { ChartLegend } from './TimeChart';
import KptBoard from './KptBoard';
import HintSummary from './HintSummary';
import ReviewControl from './ReviewControl';
import GameControl from './GameControl';
import { effectiveScore } from './scoring';
import { AI_FEEDBACK_AUTHOR, type GamedayData } from './types';

const POLL_MS = 3000; // gameday.json を 3 秒ごとに再取得してリアルタイム反映
const HINTS_STORAGE_KEY = 'gameday-revealed-hints';

function loadRevealed(): Set<string> {
  try {
    const raw = localStorage.getItem(HINTS_STORAGE_KEY);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

export default function App() {
  const [data, setData] = useState<GamedayData | null>(null);
  const [error, setError] = useState<string | null>(null); // 初回ロード失敗のみ全画面エラー
  const [stale, setStale] = useState(false); // ポーリング失敗 (前回表示を保持)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // クライアント側の楽観的開示 (即時反映 + 静的ビルドのフォールバック)。
  // サーバに記録された data.hintReveals と union して最終的な開示集合にする。
  const [localReveals, setLocalReveals] = useState<Set<string>>(loadRevealed);
  // 検知宣言の楽観更新 (injectId → 宣言時刻)。サーバ記録 (inject.ackAt) が来たらそちらが正
  const [localAcks, setLocalAcks] = useState<ReadonlyMap<string, string>>(new Map());

  // gameday.json を定期ポーリングし、内容が変わったときだけ再描画する。
  // 運営が GameDay 中に JSON を編集すると数秒で画面へ反映される。
  useEffect(() => {
    let cancelled = false;
    let lastRaw = '';
    const load = async (initial: boolean) => {
      try {
        const res = await fetch('data/gameday.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.text();
        if (cancelled) return;
        if (raw !== lastRaw) {
          lastRaw = raw;
          setData(JSON.parse(raw) as GamedayData);
        }
        setLastUpdated(new Date());
        setStale(false);
      } catch (err) {
        if (cancelled) return;
        // 初回だけ全画面エラー。ポーリング中の失敗は前回の表示を保持する (画面を消さない)。
        if (initial) setError(err instanceof Error ? err.message : String(err));
        else setStale(true);
      }
    };
    void load(true);
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (data) document.title = `${data.event.title} — ダッシュボード`;
  }, [data]);

  // 合計実効スコアを DynamoDB へ同期する (dev サーバ /api/score 経由)。
  // 閾値に達すると DynamoDB Streams → Lambda が「次の障害」を自動発火する (AWS 側)。
  // best-effort: エンドポイント不在 (静的ビルド) や未認証でも画面は動く。
  useEffect(() => {
    if (!data) return;
    const revealedIds = new Set<string>([
      ...(data.hintReveals ?? []).map((r) => r.hintId),
      ...localReveals,
    ]);
    const total = data.injects.reduce(
      (sum, i) => sum + (effectiveScore(i, revealedIds, data.scoring) ?? 0),
      0,
    );
    void fetch('api/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ total }),
    }).catch(() => {
      /* 同期は best-effort */
    });
  }, [data, localReveals]);

  const reveal = useCallback((injectId: string, hintId: string) => {
    // 1) 即時反映 + フォールバック用に localStorage へ
    setLocalReveals((prev) => {
      if (prev.has(hintId)) return prev;
      const next = new Set(prev).add(hintId);
      try {
        localStorage.setItem(HINTS_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // localStorage 不可でも画面上は開示する
      }
      return next;
    });
    // 2) サーバ (dev) に記録 → gameday.json の hintReveals に追記され、ポーリングで全員に共有。
    //    静的ビルドやエンドポイント不在時は失敗するが、上の楽観更新で画面は開示される。
    void fetch('api/reveal-hint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ injectId, hintId }),
    }).catch(() => {
      /* 記録は best-effort */
    });
  }, []);

  // 検知宣言。1) 楽観更新で即時にボタンを「宣言済み」へ 2) サーバ (dev) に記録。
  // サーバは gameday.json の inject.ackAt + events[] に永続化し、ポーリングで全員に共有される。
  const ack = useCallback((injectId: string) => {
    setLocalAcks((prev) => {
      if (prev.has(injectId)) return prev;
      const next = new Map(prev);
      next.set(injectId, new Date().toISOString());
      return next;
    });
    void fetch('api/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ injectId }),
    }).catch(() => {
      /* 記録は best-effort */
    });
  }, []);

  if (error) {
    return (
      <div className="page">
        <div className="load-error">
          <p>{`データ (data/gameday.json) を読み込めませんでした: ${error}`}</p>
          <p>プロジェクトルートで npm run dashboard を実行して開いてください。</p>
        </div>
      </div>
    );
  }
  if (!data) return null;

  // 楽観更新の検知宣言をマージ (サーバ記録 inject.ackAt が正、無ければローカル宣言を表示)。
  // ラウンド/シナリオの絞り込みプルダウンは 2026-07-18 のリハーサルで「選択肢がほぼ無く
  // ノイズ」と判断して撤去した (参加者 1 人・少インジェクト運用)。ラウンドの見出し行・
  // 小計 (ScoreTable) は情報として残っている。
  const injects = data.injects.map((i) =>
    !i.ackAt && localAcks.has(i.id) ? { ...i, ackAt: localAcks.get(i.id) } : i,
  );
  const feedback = data.feedback;

  // 最終的な開示集合 = サーバ記録 (hintReveals) ∪ クライアント楽観更新
  const serverRevealedIds = (data.hintReveals ?? []).map((r) => r.hintId);
  const revealed = new Set<string>([...serverRevealedIds, ...localReveals]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{data.event.title}</h1>
          <p className="event-meta">{[data.event.date, data.event.team].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="live" aria-live="polite">
          <span className={stale ? 'live-badge stale' : 'live-badge'}>
            <span className="live-dot" />
            {stale ? '更新エラー' : 'LIVE'}
          </span>
          <span className="live-time">
            最終更新 {lastUpdated ? lastUpdated.toLocaleTimeString('ja-JP') : '—'}
          </span>
        </div>
      </header>

      {/* 運営用のゲーム進行コントロール: GameDay 開始 / リトライ (周回リセット)。
          dev サーバの /api/start・/api/reset を呼ぶため dev のみ (静的ビルドには出ない) */}
      {import.meta.env.DEV && <GameControl data={data} />}

      {data.event.note && (
        <div className="filter-row">
          <p className="filter-note">{data.event.note}</p>
        </div>
      )}

      {/* 進行中インシデント: 常に表示する (見逃し防止) */}
      <AckBanner injects={injects} onAck={ack} />

      <Tiles injects={injects} revealed={revealed} scoring={data.scoring} />

      {data.systems && data.systems.length > 0 && (
        <Architecture systems={data.systems} scenarioId="" />
      )}

      <section className="card">
        <h2>スコア表</h2>
        <p className="card-sub">
          インジェクト (運営からの指示) ごとの対応と採点。行を開くと指示・対応の記録が見える。
          ヒントはポイントを消費して開示でき、消費分はスコアから引かれる。
          検知・復旧が自動記録されたインジェクトは検知の速さと MTTR から自動採点される。
        </p>
        <ScoreTable
          injects={injects}
          revealed={revealed}
          onReveal={reveal}
          onAck={ack}
          rounds={data.rounds}
          scoring={data.scoring}
        />
      </section>

      <HintSummary
        reveals={(data.hintReveals ?? []).filter((r) => injects.some((i) => i.id === r.injectId))}
        injects={injects}
      />

      <section className="card">
        <div className="card-head">
          <div>
            <h2>検知と復旧にかかった時間</h2>
            <p className="card-sub">インジェクトごとの検知 (気づくまで) と復旧 (定常状態に戻るまで) の分数。</p>
          </div>
          <ChartLegend />
        </div>
        <TimeChart injects={injects} />
      </section>

      <section className="card">
        <h2>振り返りフィードバック</h2>
        <p className="card-sub">
          KPT (Keep / Problem / Try)。「AI 講評」ボタンは実測データ (タイムライン・採点・ヒント消費)
          から KPT を自動生成し、このボードに author 付きで並ぶ。
        </p>
        <KptBoard feedback={feedback} />
        {/* AI 講評の生成 (dev サーバの /api/review → Bedrock)。再生成は AI 分だけ入れ替え */}
        {import.meta.env.DEV && (
          <ReviewControl
            hasAiFeedback={feedback.some((f) => f.author === AI_FEEDBACK_AUTHOR)}
          />
        )}
      </section>

      <footer className="page-footer">
        <p>
          データ: <code>dashboard/public/data/gameday.json</code> を編集すると {POLL_MS / 1000} 秒ごとに自動反映される (npm run dashboard)
        </p>
      </footer>
    </div>
  );
}
