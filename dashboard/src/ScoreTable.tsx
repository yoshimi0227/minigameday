import type { Inject, InjectStatus, ScoringConfig } from './types';
import { fmtMinutes } from './types';
import {
  DEFAULT_SCORING,
  autoScoreBreakdown,
  effectiveScore,
  hintPenalty,
  resolveScore,
} from './scoring';
import Hints from './Hints';

const STATUS: Record<InjectStatus, { label: string; icon: string; color: string }> = {
  success: { label: '成功', icon: '✓', color: 'var(--status-good)' },
  partial: { label: '一部達成', icon: '▲', color: 'var(--status-warning)' },
  failed: { label: '失敗', icon: '✕', color: 'var(--status-critical)' },
  pending: { label: '進行中', icon: '…', color: 'var(--text-muted)' },
  // ライブ状態 (gameEventsSync が導出)
  armed: { label: '実験進行中', icon: '⏱', color: 'var(--text-muted)' },
  impacted: { label: '影響発生中', icon: '⚠', color: 'var(--status-critical)' },
  recovered: { label: '復旧済み', icon: '✓', color: 'var(--status-good)' },
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

function ScoreCell({
  inject,
  revealed,
  scoring,
}: {
  inject: Inject;
  revealed: ReadonlySet<string>;
  scoring: ScoringConfig;
}) {
  const base = resolveScore(inject, scoring);
  if (base === undefined || !inject.maxScore) {
    return <span className="score-max">未採点</span>;
  }
  const penalty = hintPenalty(inject, revealed);
  const eff = effectiveScore(inject, revealed, scoring) ?? base;
  const pct = Math.max(0, Math.min(100, (eff / inject.maxScore) * 100));
  // 自動採点のときは内訳を小書きで示す (scoreOverride 時は手動裁定なので出さない)
  const breakdown =
    typeof inject.scoreOverride === 'number' ? undefined : autoScoreBreakdown(inject, scoring);
  return (
    <>
      <div>
        <span className="score-num">{eff}</span>
        <span className="score-max">{` / ${inject.maxScore}`}</span>
        {penalty > 0 && <span className="score-penalty">{`（${base} − ${penalty}pt）`}</span>}
      </div>
      {breakdown && (
        <div className="score-breakdown">
          {`検知 ${breakdown.detection}/${scoring.detection.maxPoints} · 復旧 ${breakdown.recovery}/${scoring.recovery.maxPoints} · 伝達 ${breakdown.comms}/${scoring.commsMaxPoints}`}
        </div>
      )}
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
  onAck,
  scoring = DEFAULT_SCORING,
}: {
  injects: Inject[];
  revealed: ReadonlySet<string>;
  onReveal: (injectId: string, hintId: string) => void;
  onAck?: (injectId: string) => void;
  scoring?: ScoringConfig;
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
                <td>
                  <StatusChip status={inject.status} />
                  {onAck && inject.impactStartAt && !inject.ackAt && (
                    <button
                      type="button"
                      className="ack-button small"
                      onClick={() => onAck(inject.id)}
                    >
                      検知宣言
                    </button>
                  )}
                </td>
                <td className="num"><Minutes value={inject.detectionMinutes} /></td>
                <td className="num"><Minutes value={inject.recoveryMinutes} /></td>
                <td className="score-cell">
                  <ScoreCell inject={inject} revealed={revealed} scoring={scoring} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
