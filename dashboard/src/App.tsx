import { useEffect, useState } from 'react';
import Tiles from './Tiles';
import ScoreTable from './ScoreTable';
import TimeChart, { ChartLegend } from './TimeChart';
import KptBoard from './KptBoard';
import type { GamedayData } from './types';

export default function App() {
  const [data, setData] = useState<GamedayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('data/gameday.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as GamedayData;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (data) document.title = `${data.event.title} — ダッシュボード`;
  }, [data]);

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

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{data.event.title}</h1>
          <p className="event-meta">{[data.event.date, data.event.team].filter(Boolean).join(' · ')}</p>
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

      <Tiles injects={injects} />

      <section className="card">
        <h2>スコア表</h2>
        <p className="card-sub">
          インジェクト (運営からの指示) ごとの対応と採点。行を開くと指示・対応の記録が見える。
        </p>
        <ScoreTable injects={injects} />
      </section>

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
          データ: <code>dashboard/public/data/gameday.json</code> を編集 → 保存で即時反映 (npm run dashboard)
        </p>
      </footer>
    </div>
  );
}
