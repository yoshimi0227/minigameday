import type { Inject } from './types';

/**
 * 進行中インシデントのバナー。armed (実験進行中 — 障害はまだ) と
 * impacted (canary が異常検知 — 影響発生中) の inject を大きく表示する。
 *
 * 「検知を宣言する」ボタンは impacted になってから有効になる。armed 中に押せると
 * 「開始直後に宣言しておけば検知 40 点が必ず満点」という抜け道になるため
 * (検知点は impactStartAt → ackAt の速さで決まる)。サーバ側 (/api/ack) も同じ条件で弾く。
 */
export default function AckBanner({
  injects,
  onAck,
}: {
  injects: Inject[];
  onAck: (injectId: string) => void;
}) {
  const active = injects.filter((i) => i.status === 'armed' || i.status === 'impacted');
  if (active.length === 0) return null;
  return (
    <section aria-live="polite" aria-label="進行中のインシデント">
      {active.map((inject) => {
        const impacted = inject.status === 'impacted';
        return (
          <div key={inject.id} className={impacted ? 'ack-banner impacted' : 'ack-banner armed'}>
            <div className="ack-banner-body">
              <span className="ack-banner-state">
                {impacted ? '🚨 影響発生中' : '⏱ 実験進行中'}
              </span>
              <span className="ack-banner-title">{inject.title}</span>
              <span className="ack-banner-note">
                {impacted
                  ? 'canary が異常を検知。まず「検知宣言」、それから対応へ。宣言が早いほど検知点が高い。'
                  : '障害はいつ来るか分からない。canary と Slack を見張ろう。'}
              </span>
            </div>
            {impacted &&
              (inject.ackAt ? (
                <span className="ack-done">
                  {`✓ 検知宣言 ${new Date(inject.ackAt).toLocaleTimeString('ja-JP')}`}
                </span>
              ) : (
                <button type="button" className="ack-button" onClick={() => onAck(inject.id)}>
                  🚨 検知を宣言する
                </button>
              ))}
          </div>
        );
      })}
    </section>
  );
}
