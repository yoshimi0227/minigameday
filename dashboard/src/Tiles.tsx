import type { Inject, ScoringConfig } from './types';
import { fmtMinutes } from './types';
import { DEFAULT_SCORING, effectiveScore, hintPenalty, resolveScore } from './scoring';

function average(injects: Inject[], key: 'detectionMinutes' | 'recoveryMinutes'): number | null {
  const values = injects.map((i) => i[key]).filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** 「消化済み」= 確定またはひと山越えた状態。進行中 (pending/armed/impacted) は含めない */
const DONE_STATUSES = new Set(['success', 'partial', 'failed', 'recovered']);

export default function Tiles({
  injects,
  revealed,
  scoring = DEFAULT_SCORING,
}: {
  injects: Inject[];
  revealed: ReadonlySet<string>;
  scoring?: ScoringConfig;
}) {
  const scored = injects.filter((i) => resolveScore(i, scoring) !== undefined);
  // 実効スコア = 素点 (自動採点 or 手動) − ヒント消費。総合はその合計
  const totalScore = scored.reduce((sum, i) => sum + (effectiveScore(i, revealed, scoring) ?? 0), 0);
  const totalMax = scored.reduce((sum, i) => sum + (i.maxScore ?? 0), 0);
  const totalPenalty = injects.reduce((sum, i) => sum + hintPenalty(i, revealed), 0);
  const done = injects.filter((i) => i.status && DONE_STATUSES.has(i.status)).length;
  const avgDetection = average(injects, 'detectionMinutes');
  const avgRecovery = average(injects, 'recoveryMinutes');

  const tiles = [
    {
      label: '総合スコア',
      value: String(totalScore),
      unit: ` / ${totalMax}`,
      hero: true,
      delta: totalPenalty > 0 ? `ヒント消費 −${totalPenalty}pt` : null,
    },
    { label: '平均検知時間', value: avgDetection === null ? '—' : fmtMinutes(avgDetection), unit: ' 分', delta: null },
    { label: '平均復旧時間', value: avgRecovery === null ? '—' : fmtMinutes(avgRecovery), unit: ' 分', delta: null },
    { label: 'インジェクト消化', value: String(done), unit: ` / ${injects.length}`, delta: null },
  ];

  return (
    <section className="tiles" aria-label="サマリー">
      {tiles.map((t) => (
        <div key={t.label} className={t.hero ? 'tile hero' : 'tile'}>
          <div className="tile-label">{t.label}</div>
          <div className="tile-value">
            {t.value}
            <span className="unit">{t.unit}</span>
          </div>
          {t.delta && <div className="tile-delta">{t.delta}</div>}
        </div>
      ))}
    </section>
  );
}
