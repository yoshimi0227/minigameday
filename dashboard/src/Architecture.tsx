import { Fragment, useEffect, useState } from 'react';
import { AWS_ICONS } from './awsIcons';
import type { TargetSystem } from './types';

/**
 * お題システムの構成図 + 軽い補足 (本物の GameDay の「元のシステム構成図」に相当)。
 * AWS 公式アーキテクチャアイコンで描く: 層 (サブネット等) をグループボックス、
 * リソースを「アイコン + 名前」で置き、上から下へ矢印でつなぐ。
 * シナリオフィルタが変わると、そのシナリオを対象とするシステムへタブが自動で切り替わる。
 */
export default function Architecture({
  systems,
  scenarioId,
}: {
  systems: TargetSystem[];
  scenarioId: string;
}) {
  const [activeId, setActiveId] = useState(systems[0]?.id ?? '');
  // 当日はプロジェクタ表示のため折りたたみ可能にする。App はポーリングで数秒ごとに
  // 再レンダーされるので、details の開閉は state で保持する (DOM 任せだと開き直る)。
  const [open, setOpen] = useState(true);

  // シナリオフィルタとの連動。手動のタブ切り替えはそのまま有効。
  useEffect(() => {
    if (!scenarioId) return;
    const match = systems.find((s) => s.scenarioIds.includes(scenarioId));
    if (match) setActiveId(match.id);
  }, [scenarioId, systems]);

  const active = systems.find((s) => s.id === activeId) ?? systems[0];
  if (!active) return null;

  return (
    <section className="card">
      <details
        className="arch"
        open={open}
        onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="arch-head">
          <h2>お題システム</h2>
          <p className="card-sub">
            今日の GameDay で障害が注入される対象。これが「元の構成」(定常状態) で、
            ここからの逸脱を canary とメトリクスで観測して対応する。
          </p>
        </summary>

        {systems.length > 1 && (
          <div className="arch-tabs">
            {systems.map((s) => (
              <button
                key={s.id}
                type="button"
                className={s.id === active.id ? 'arch-tab active' : 'arch-tab'}
                aria-pressed={s.id === active.id}
                onClick={() => setActiveId(s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}

        {/* scenarioIds は運営用のデータ紐付け (scenarios/ との突き合わせ)。内部 ID を
            参加者に見せても意味が無いので画面には出さない (2026-07-18 リハーサル判断) */}
        <p className="arch-summary">{active.summary}</p>

        <div className="arch-diagram">
          {active.tiers.map((tier, i) => (
            <Fragment key={tier.name}>
              {i > 0 && (
                <div className="arch-arrow" aria-hidden="true">
                  ↓
                </div>
              )}
              <div className="arch-tier">
                <div className="arch-tier-name">
                  {tier.icon && AWS_ICONS[tier.icon] && (
                    <img className="arch-tier-icon" src={AWS_ICONS[tier.icon]} alt="" />
                  )}
                  {tier.name}
                </div>
                <div className="arch-nodes">
                  {tier.nodes.map((node) => (
                    <div key={node.service + (node.label ?? '')} className="arch-node">
                      {node.icon && AWS_ICONS[node.icon] && (
                        <img className="arch-node-icon" src={AWS_ICONS[node.icon]} alt="" />
                      )}
                      <span className="arch-node-service">
                        {node.service}
                        {typeof node.count === 'number' && node.count > 1 && (
                          <span className="arch-node-count">{`×${node.count}`}</span>
                        )}
                      </span>
                      {node.label && <span className="arch-node-label">{node.label}</span>}
                    </div>
                  ))}
                </div>
                {tier.note && <p className="arch-tier-note">{tier.note}</p>}
              </div>
            </Fragment>
          ))}
        </div>

        {active.notes && active.notes.length > 0 && (
          <ul className="arch-notes">
            {active.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
