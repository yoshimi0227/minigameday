import type { HintReveal, Inject } from './types';

/**
 * ヒント消費サマリ。gameday.json の hintReveals (サーバ記録) を集計して
 * 「どのインジェクトのどのヒントに何ポイント使ったか」を出す。振り返りの素材。
 */
export default function HintSummary({
  reveals,
  injects,
}: {
  reveals: HintReveal[];
  injects: Inject[];
}) {
  if (reveals.length === 0) return null;

  const titleOf = (injectId: string) => injects.find((i) => i.id === injectId)?.title ?? injectId;
  const total = reveals.reduce((sum, r) => sum + (r.cost ?? 0), 0);

  // インジェクトごとにまとめる
  const byInject = new Map<string, HintReveal[]>();
  for (const r of reveals) {
    const list = byInject.get(r.injectId) ?? [];
    list.push(r);
    byInject.set(r.injectId, list);
  }

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('ja-JP');
  };

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>ヒント消費サマリ</h2>
          <p className="card-sub">
            開示されたヒントの記録 (gameday.json の hintReveals)。消費が多いほど詰まった目安 = 振り返りの素材。
          </p>
        </div>
        <div className="hint-total">
          合計 <strong>−{total}</strong> pt
        </div>
      </div>
      <div className="hint-summary">
        {[...byInject.entries()].map(([injectId, list]) => {
          const subtotal = list.reduce((sum, r) => sum + (r.cost ?? 0), 0);
          return (
            <div key={injectId} className="hint-summary-group">
              <div className="hint-summary-inject">
                {titleOf(injectId)} <span className="hint-summary-subtotal">−{subtotal}pt</span>
              </div>
              <ul className="hint-summary-list">
                {list.map((r) => (
                  <li key={r.hintId} className="hint-summary-item">
                    <span className="hint-label">{r.label}</span>
                    <span className="hint-cost spent">−{r.cost}pt</span>
                    <span className="hint-summary-time">{fmtTime(r.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
