import { Fragment } from 'react';
import type { Inject, InjectStatus, RoundDef, ScoringConfig } from './types';
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

function InjectRow({
  inject,
  revealed,
  onReveal,
  onAck,
  scoring,
}: {
  inject: Inject;
  revealed: ReadonlySet<string>;
  onReveal: (injectId: string, hintId: string) => void;
  onAck?: (injectId: string) => void;
  scoring: ScoringConfig;
}) {
  const detailRows = [
    ['指示 (インジェクト)', inject.instruction],
    ['チームの対応', inject.response],
    ['採点メモ', inject.notes],
  ].filter((r): r is [string, string] => Boolean(r[1]));
  return (
    <tr>
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
          <button type="button" className="ack-button small" onClick={() => onAck(inject.id)}>
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
}

/** ラウンドごとの小計 (実効スコア合計 / 満点合計)。採点済みだけを分子に、満点は全件を分母に */
function roundSubtotal(
  injects: Inject[],
  revealed: ReadonlySet<string>,
  scoring: ScoringConfig,
): { got: number; max: number } {
  return injects.reduce(
    (acc, i) => ({
      got: acc.got + (effectiveScore(i, revealed, scoring) ?? 0),
      max: acc.max + (i.maxScore ?? 0),
    }),
    { got: 0, max: 0 },
  );
}

export default function ScoreTable({
  injects,
  revealed,
  onReveal,
  onAck,
  rounds,
  scoring = DEFAULT_SCORING,
}: {
  injects: Inject[];
  revealed: ReadonlySet<string>;
  onReveal: (injectId: string, hintId: string) => void;
  onAck?: (injectId: string) => void;
  rounds?: RoundDef[];
  scoring?: ScoringConfig;
}) {
  // ラウンドが 1 つも設定されていなければグループ見出しは出さず従来どおりフラット表示。
  const hasRounds = injects.some((i) => typeof i.round === 'number');
  // 出現順を保ったラウンドのキー列 (未分類は最後にまとめる)
  const roundKeys: (number | null)[] = [];
  for (const i of injects) {
    const key = typeof i.round === 'number' ? i.round : null;
    if (!roundKeys.includes(key)) roundKeys.push(key);
  }
  roundKeys.sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  const titleOf = (round: number | null) =>
    round === null ? 'ラウンド未分類' : rounds?.find((r) => r.round === round)?.title ?? `ラウンド ${round}`;

  const rowsFor = (list: Inject[]) =>
    list.map((inject) => (
      <InjectRow
        key={inject.id}
        inject={inject}
        revealed={revealed}
        onReveal={onReveal}
        onAck={onAck}
        scoring={scoring}
      />
    ));

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
          {!hasRounds && rowsFor(injects)}
          {hasRounds &&
            roundKeys.map((key) => {
              const list = injects.filter((i) => (typeof i.round === 'number' ? i.round : null) === key);
              const sub = roundSubtotal(list, revealed, scoring);
              return (
                <Fragment key={`round-${key}`}>
                  <tr className="round-header">
                    <td colSpan={5}>{titleOf(key)}</td>
                    <td className="score-col">{`小計 ${sub.got} / ${sub.max}`}</td>
                  </tr>
                  {rowsFor(list)}
                </Fragment>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
