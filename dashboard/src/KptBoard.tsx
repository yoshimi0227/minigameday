import type { Feedback, FeedbackType } from './types';

const KPT_COLUMNS: { type: FeedbackType; label: string; sub: string; color: string }[] = [
  { type: 'keep', label: 'Keep', sub: '続けたいこと', color: 'var(--status-good)' },
  { type: 'problem', label: 'Problem', sub: '課題', color: 'var(--status-critical)' },
  { type: 'try', label: 'Try', sub: '次に試すこと', color: 'var(--series-1)' },
];

export default function KptBoard({ feedback }: { feedback: Feedback[] }) {
  return (
    <div className="kpt">
      {KPT_COLUMNS.map((col) => {
        const items = feedback.filter((f) => f.type === col.type);
        return (
          <div key={col.type}>
            <div className="kpt-col-head">
              <span className="dot" style={{ background: col.color }} />
              {`${col.label} — ${col.sub} `}
              <span className="count">{`(${items.length})`}</span>
            </div>
            {items.length === 0 && <p className="kpt-empty">まだありません</p>}
            {items.map((item, i) => {
              const meta = [item.author, item.scenarioId].filter(Boolean).join(' · ');
              return (
                <div key={`${col.type}-${i}`} className="kpt-card">
                  <p className="comment">{item.comment}</p>
                  {meta && <p className="meta">{meta}</p>}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
