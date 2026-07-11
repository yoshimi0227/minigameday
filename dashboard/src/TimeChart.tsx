import { useRef, useState } from 'react';
import type { Inject } from './types';
import { fmtMinutes } from './types';

// 系列色は styles.css の検証済みパレット (dataviz スキル) のロール変数を参照する
const SERIES = [
  { key: 'detectionMinutes', label: '検知', color: 'var(--series-1)' },
  { key: 'recoveryMinutes', label: '復旧', color: 'var(--series-2)' },
] as const;

const MARGIN = { top: 6, right: 64, bottom: 30, left: 170 };
const BAR_H = 16;
const BAR_GAP = 2; // surface gap: 隣接するバーは 2px の余白で区切る
const GROUP_PAD = 16;
const ROW_H = BAR_H * 2 + BAR_GAP + GROUP_PAD;
const WIDTH = 760;

// 横棒: データ端 (右) のみ 4px 丸め、ベースライン (左) は角のまま
function roundedBarPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h / 2);
  return `M ${x} ${y} h ${w - r} a ${r} ${r} 0 0 1 ${r} ${r} v ${h - 2 * r} a ${r} ${r} 0 0 1 ${-r} ${r} h ${-(w - r)} Z`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface TooltipState {
  inject: Inject;
  left: number;
  top: number;
}

export function ChartLegend() {
  return (
    <div className="legend">
      {SERIES.map((s) => (
        <span key={s.key} className="legend-item">
          <span className="legend-swatch" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export default function TimeChart({ injects }: { injects: Inject[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const rows = injects.filter(
    (i) => typeof i.detectionMinutes === 'number' || typeof i.recoveryMinutes === 'number',
  );
  if (rows.length === 0) {
    return <p className="kpt-empty">まだ時間の記録がありません</p>;
  }

  const maxValue = Math.max(1, ...rows.flatMap((r) => SERIES.map((s) => r[s.key] ?? 0)));
  const step = maxValue <= 10 ? 2 : 5;
  const xMax = Math.ceil(maxValue / step) * step;
  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const height = MARGIN.top + rows.length * ROW_H + MARGIN.bottom;
  const x = (v: number) => MARGIN.left + (v / xMax) * plotW;

  const ticks: number[] = [];
  for (let v = 0; v <= xMax; v += step) ticks.push(v);

  const showTooltip = (inject: Inject, clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(0, Math.min(clientX - rect.left + 14, rect.width - 200));
    setTooltip({ inject, left, top: clientY - rect.top + 14 });
  };

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="インジェクトごとの検知・復旧時間 (分)">
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={x(v)} x2={x(v)} y1={MARGIN.top} y2={height - MARGIN.bottom}
              className={v === 0 ? 'baseline-line' : 'gridline'}
            />
            <text x={x(v)} y={height - MARGIN.bottom + 16} textAnchor="middle" className="axis-text">
              {v === xMax ? `${v} 分` : String(v)}
            </text>
          </g>
        ))}

        {rows.map((inject, i) => {
          const groupY = MARGIN.top + i * ROW_H + GROUP_PAD / 2;
          const ariaValues = SERIES.map((s) => `${s.label} ${fmtMinutes(inject[s.key] ?? 0)}分`).join('、');
          return (
            <g key={inject.id}>
              <text
                x={MARGIN.left - 8} y={groupY + BAR_H + BAR_GAP / 2 + 4}
                textAnchor="end" className="row-label"
              >
                {truncate(inject.title, 13)}
              </text>
              <g
                className="bar-hit"
                tabIndex={0}
                aria-label={`${inject.title}: ${ariaValues}`}
                onPointerMove={(e) => showTooltip(inject, e.clientX, e.clientY)}
                onPointerLeave={() => setTooltip(null)}
                onFocus={() => {
                  const rect = wrapRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  showTooltip(inject, rect.left + rect.width / 2, rect.top + ((groupY + ROW_H) / height) * rect.height);
                }}
                onBlur={() => setTooltip(null)}
              >
                {/* ヒットターゲットはマークより大きく (行全体を透明矩形で覆う) */}
                <rect
                  x={MARGIN.left} y={groupY - GROUP_PAD / 2}
                  width={WIDTH - MARGIN.left - MARGIN.right + 48} height={ROW_H}
                  fill="transparent"
                />
                {SERIES.map((s, j) => {
                  const v = inject[s.key];
                  if (typeof v !== 'number') return null;
                  const y = groupY + j * (BAR_H + BAR_GAP);
                  const w = Math.max(0, x(v) - MARGIN.left);
                  return (
                    <g key={s.key}>
                      {w > 0 && (
                        <path d={roundedBarPath(MARGIN.left, y, w, BAR_H)} className="bar" style={{ fill: s.color }} />
                      )}
                      {/* 直接ラベル (バー先端の外側)。ライトモードの aqua は 3:1 未満なので必須の救済 */}
                      <text x={x(v) + 6} y={y + BAR_H - 4} className="value-label">
                        {`${fmtMinutes(v)}分`}
                      </text>
                    </g>
                  );
                })}
              </g>
            </g>
          );
        })}
      </svg>

      {tooltip && (
        <div className="tooltip visible" style={{ left: tooltip.left, top: tooltip.top }}>
          <div className="tt-title">{tooltip.inject.title}</div>
          {SERIES.map((s) => {
            const v = tooltip.inject[s.key];
            return (
              <div key={s.key} className="tt-row">
                <span className="tt-key" style={{ background: s.color }} />
                <span className="tt-value">{typeof v === 'number' ? `${fmtMinutes(v)}分` : '—'}</span>
                <span className="tt-name">{s.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
