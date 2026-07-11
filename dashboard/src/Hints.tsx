import type { Inject } from './types';

/**
 * インジェクトごとの段階ヒント。ロックされたヒントをクリックすると
 * ポイントを消費して本文が開示される (消費はスコアから引かれる)。
 * 開示状態は App が localStorage に保持する。
 */
export default function Hints({
  inject,
  revealed,
  onReveal,
}: {
  inject: Inject;
  revealed: ReadonlySet<string>;
  onReveal: (injectId: string, hintId: string) => void;
}) {
  const hints = inject.hints ?? [];
  if (hints.length === 0) return null;

  return (
    <div className="hints">
      <div className="hints-head">💡 ヒント（ポイント消費で開示）</div>
      <ol className="hints-list">
        {hints.map((h) => {
          const open = revealed.has(h.id);
          return (
            <li key={h.id} className={open ? 'hint open' : 'hint'}>
              {open ? (
                <div className="hint-body">
                  <div className="hint-line">
                    <span className="hint-label">{h.label}</span>
                    <span className="hint-cost spent">−{h.cost}pt 消費済み</span>
                  </div>
                  <p className="hint-text">{h.text}</p>
                </div>
              ) : (
                <button type="button" className="hint-reveal" onClick={() => onReveal(inject.id, h.id)}>
                  <span className="hint-lock">🔒</span>
                  {`${h.label} を見る`}
                  <span className="hint-cost">{`（−${h.cost}pt）`}</span>
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
