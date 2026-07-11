import type { Inject } from './types';
import { effectiveScore, fmtMinutes, hintPenalty } from './types';

function average(injects: Inject[], key: 'detectionMinutes' | 'recoveryMinutes'): number | null {
  const values = injects.map((i) => i[key]).filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export default function Tiles({
  injects,
  revealed,
}: {
  injects: Inject[];
  revealed: ReadonlySet<string>;
}) {
  const scored = injects.filter((i) => typeof i.score === 'number');
  // 実効スコア = 獲得 − ヒント消費。総合はその合計
  const totalScore = scored.reduce((sum, i) => sum + (effectiveScore(i, revealed) ?? 0), 0);
  const totalMax = scored.reduce((sum, i) => sum + (i.maxScore ?? 0), 0);
  const totalPenalty = injects.reduce((sum, i) => sum + hintPenalty(i, revealed), 0);
  const done = injects.filter((i) => i.status && i.status !== 'pending').length;
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
