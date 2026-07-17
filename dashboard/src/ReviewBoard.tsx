import type { Inject, Review } from './types';

/**
 * ゲーム終了後の振り返りレビュー。gameday.json に review セクションがあるときだけ表示される
 * (gameday-retrospective スキルが講評を生成して書き込む)。
 * 講評テキストは自由入力なので JSX テキストとしてのみ描画し、改行は pre-line で表現する。
 */
export default function ReviewBoard({ review, injects }: { review: Review; injects: Inject[] }) {
  const titleOf = (injectId: string) =>
    injects.find((i) => i.id === injectId)?.title ?? injectId;
  return (
    <section className="card review-board">
      <h2>振り返りレビュー</h2>
      <p className="card-sub">
        {`生成 ${new Date(review.generatedAt).toLocaleString('ja-JP')}`}
        {review.reportPath && (
          <>
            {' · 詳細レポート: '}
            <code>{review.reportPath}</code>
          </>
        )}
      </p>
      <p className="review-overall">{review.overall}</p>
      <div className="review-grid">
        {review.injects.map((r) => (
          <article key={r.injectId} className="review-card">
            <h3 className="review-headline">{r.headline}</h3>
            <p className="review-inject">{titleOf(r.injectId)}</p>
            <p className="review-commentary">{r.commentary}</p>
            {(r.wentWell?.length ?? 0) > 0 && (
              <ul className="review-list went-well">
                {r.wentWell!.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            {(r.toImprove?.length ?? 0) > 0 && (
              <ul className="review-list to-improve">
                {r.toImprove!.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
