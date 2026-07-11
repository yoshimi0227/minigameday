import type { Inject, InjectStatus } from './types';
import { effectiveScore, fmtMinutes, hintPenalty } from './types';
import Hints from './Hints';

const STATUS: Record<InjectStatus, { label: string; icon: string; color: string }> = {
  success: { label: '成功', icon: '✓', color: 'var(--status-good)' },
  partial: { label: '一部達成', icon: '▲', color: 'var(--status-warning)' },
  failed: { label: '失敗', icon: '✕', color: 'var(--status-critical)' },
  pending: { label: '進行中', icon: '…', color: 'var(--text-muted)' },
};

function StatusChip({ status }: { status?: InjectStatus }) {
  const meta = STATUS[status ?? 'pending'] ?? STATUS.pending;
  return (
    <span className="chip">
      <span className="dot" style={{ background: meta.color }} />
      {`${meta.icon} ${meta.label}`}
    </span>
  );
}

function Minutes({ value }: { value?: number }) {
  return <>{typeof value === 'number' ? `${fmtMinutes(value)} 分` : '—'}</>;
}

function ScoreCell({ inject, revealed }: { inject: Inject; revealed: ReadonlySet<string> }) {
  if (typeof inject.score !== 'number' || !inject.maxScore) {
    return <span className="score-max">未採点</span>;
  }
  const penalty = hintPenalty(inject, revealed);
  const eff = effectiveScore(inject, revealed) ?? inject.score;
  const pct = Math.max(0, Math.min(100, (eff / inject.maxScore) * 100));
  return (
    <>
      <div>
        <span className="score-num">{eff}</span>
        <span className="score-max">{` / ${inject.maxScore}`}</span>
        {penalty > 0 && <span className="score-penalty">{`（${inject.score} − ${penalty}pt）`}</span>}
      </div>
      <div className="meter">
        <span style={{ width: `${pct}%` }} />
      </div>
    </>
  );
}

export default function ScoreTable({
  injects,
  revealed,
  onReveal,
}: {
  injects: Inject[];
  revealed: ReadonlySet<string>;
  onReveal: (id: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">時刻</th>
            <th scope="col">インジェクト</th>
            <th scope="col">結果</th>
            <th scope="col" className="num">検知</th>
            <th scope="col" className="num">復旧</th>
            <th scope="col" className="score-col">スコア</th>
          </tr>
        </thead>
        <tbody>
          {injects.length === 0 && (
            <tr>
              <td className="kpt-empty" colSpan={6}>該当するインジェクトがありません</td>
            </tr>
          )}
          {injects.map((inject) => {
            const detailRows = [
              ['指示 (インジェクト)', inject.instruction],
              ['チームの対応', inject.response],
              ['採点メモ', inject.notes],
            ].filter((r): r is [string, string] => Boolean(r[1]));
            return (
              <tr key={inject.id}>
                <td className="time">{inject.time ?? '—'}</td>
                <td>
                  <div>
                    <span className="inject-title">{inject.title}</span>
                    {inject.scenarioId && <span className="inject-scenario">{inject.scenarioId}</span>}
                  </div>
                  {detailRows.length > 0 && (
                    <details className="inject-detail">
                      <summary>指示・対応の記録</summary>
                      <dl>
                        {detailRows.map(([dt, dd]) => (
                          <div key={dt}>
                            <dt>{dt}</dt>
                            <dd>{dd}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  )}
                  <Hints inject={inject} revealed={revealed} onReveal={onReveal} />
                </td>
                <td><StatusChip status={inject.status} /></td>
                <td className="num"><Minutes value={inject.detectionMinutes} /></td>
                <td className="num"><Minutes value={inject.recoveryMinutes} /></td>
                <td className="score-cell">
                  <ScoreCell inject={inject} revealed={revealed} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
