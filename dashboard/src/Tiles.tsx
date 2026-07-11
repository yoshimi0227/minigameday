import type { Inject } from './types';
import { fmtMinutes } from './types';

function average(injects: Inject[], key: 'detectionMinutes' | 'recoveryMinutes'): number | null {
  const values = injects.map((i) => i[key]).filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export default function Tiles({ injects }: { injects: Inject[] }) {
  const scored = injects.filter((i) => typeof i.score === 'number');
  const totalScore = scored.reduce((sum, i) => sum + (i.score ?? 0), 0);
  const totalMax = scored.reduce((sum, i) => sum + (i.maxScore ?? 0), 0);
  const done = injects.filter((i) => i.status && i.status !== 'pending').length;
  const avgDetection = average(injects, 'detectionMinutes');
  const avgRecovery = average(injects, 'recoveryMinutes');

  const tiles = [
    { label: '総合スコア', value: String(totalScore), unit: ` / ${totalMax}`, hero: true },
    { label: '平均検知時間', value: avgDetection === null ? '—' : fmtMinutes(avgDetection), unit: ' 分' },
    { label: '平均復旧時間', value: avgRecovery === null ? '—' : fmtMinutes(avgRecovery), unit: ' 分' },
    { label: 'インジェクト消化', value: String(done), unit: ` / ${injects.length}` },
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
        </div>
      ))}
    </section>
  );
}
