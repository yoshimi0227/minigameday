import { useCallback, useEffect, useState } from 'react';
import Tiles from './Tiles';
import ScoreTable from './ScoreTable';
import TimeChart, { ChartLegend } from './TimeChart';
import KptBoard from './KptBoard';
import HintSummary from './HintSummary';
import { effectiveScore, type GamedayData } from './types';

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
  const [scenarioId, setScenarioId] = useState('');
  // クライアント側の楽観的開示 (即時反映 + 静的ビルドのフォールバック)。
  // サーバに記録された data.hintReveals と union して最終的な開示集合にする。
  const [localReveals, setLocalReveals] = useState<Set<string>>(loadRevealed);

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
      (sum, i) => sum + (effectiveScore(i, revealedIds) ?? 0),
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

  const injects = scenarioId
    ? data.injects.filter((i) => i.scenarioId === scenarioId)
    : data.injects;
  const feedback = scenarioId
    ? data.feedback.filter((f) => f.scenarioId === scenarioId || f.scenarioId == null)
    : data.feedback;
  const scenarioIds = [
    ...new Set(data.injects.map((i) => i.scenarioId).filter((v): v is string => Boolean(v))),
  ];

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

      {/* フィルター行: この下の全セクション (タイル・表・チャート・KPT) をスコープする */}
      <div className="filter-row">
        <label className="filter">
          <span className="filter-label">シナリオ</span>
          <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
            <option value="">すべて</option>
            {scenarioIds.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>
        {data.event.note && <p className="filter-note">{data.event.note}</p>}
      </div>

      <Tiles injects={injects} revealed={revealed} />

      <section className="card">
        <h2>スコア表</h2>
        <p className="card-sub">
          インジェクト (運営からの指示) ごとの対応と採点。行を開くと指示・対応の記録が見える。
          ヒントはポイントを消費して開示でき、消費分はスコアから引かれる。
        </p>
        <ScoreTable injects={injects} revealed={revealed} onReveal={reveal} />
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
          KPT (Keep / Problem / Try)。詳細な振り返りは <code>retrospectives/</code> のレポートに残す。
        </p>
        <KptBoard feedback={feedback} />
      </section>

      <footer className="page-footer">
        <p>
          データ: <code>dashboard/public/data/gameday.json</code> を編集すると {POLL_MS / 1000} 秒ごとに自動反映される (npm run dashboard)
        </p>
      </footer>
    </div>
  );
}
