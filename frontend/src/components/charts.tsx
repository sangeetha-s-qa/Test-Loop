"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Table2 } from "lucide-react";

/**
 * Small SVG charts for the tracking dashboard, following one set of rules: thin marks with 4px
 * rounded data-ends on a shared baseline, 2px surface gaps between stacked segments, recessive
 * hairline grids, text in text colours (never the series colour), a legend whenever there are two
 * or more series, a hover tooltip on every mark, and a table view of the same numbers.
 *
 * Colours are validated roles from the dataviz palette (light surface; the product is light-only):
 * two categorical slots for created/resolved, and an ordinal blue ramp for P1..P4.
 */

export const vizColors = {
  surface: "#fcfcfb",
  grid: "#e7e6e2",
  textPrimary: "#0b0b0b",
  textSecondary: "#52514e",
  textMuted: "#7a7975",
  series1: "#2a78d6",
  series2: "#eb6834",
  /** Ordinal ramp, darkest = most urgent. Validated with --ordinal (light end 2.06:1). */
  priority: { P1: "#184f95", P2: "#2a78d6", P3: "#5598e7", P4: "#86b6ef" } as Record<string, string>,
};

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Clean axis maximum and ticks: 0 and three steps at 1/2/5 x 10^n. */
function niceTicks(max: number) {
  if (max <= 0) return { top: 4, ticks: [0, 1, 2, 3, 4] };
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map(multiple => multiple * power).find(candidate => candidate >= rough) ?? 10 * power;
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step) };
}

/** Bar path with a 4px rounded data-end and a square baseline end. */
function barPath(x: number, y: number, width: number, height: number, horizontal: boolean) {
  const r = Math.min(4, horizontal ? height / 2 : width / 2, horizontal ? width : height);
  if (width <= 0 || height <= 0) return "";
  return horizontal
    ? `M${x},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height - r} Q${x + width},${y + height} ${x + width - r},${y + height} H${x} Z`
    : `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
}

type Tip = { x: number; y: number; title: string; lines: { color?: string; label: string; value: string }[] } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div role="tooltip" className="pointer-events-none absolute z-10 min-w-36 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg" style={{ left: tip.x, top: tip.y, transform: "translate(-50%, calc(-100% - 10px))" }}>
      <p className="font-semibold" style={{ color: vizColors.textPrimary }}>{tip.title}</p>
      {tip.lines.map(line => (
        <p key={line.label} className="mt-0.5 flex items-center gap-1.5" style={{ color: vizColors.textSecondary }}>
          {line.color && <span className="inline-block h-2 w-2 rounded-full" style={{ background: line.color }} aria-hidden="true" />}
          {line.label}
          <span className="ml-auto pl-3 font-semibold tabular-nums" style={{ color: vizColors.textPrimary }}>{line.value}</span>
        </p>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: vizColors.textSecondary }}>
      {items.map(item => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: item.color }} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** A titled card with a chart, an optional legend, and a "Table" toggle showing the same numbers. */
export function ChartCard({ title, subtitle, legend, table, children }: { title: string; subtitle?: string; legend?: ReactNode; table: { columns: string[]; rows: (string | number)[][] }; children: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-bold" style={{ color: vizColors.textPrimary }}>{title}</h2>
          {subtitle && <p className="text-xs" style={{ color: vizColors.textMuted }}>{subtitle}</p>}
        </div>
        <button type="button" onClick={() => setAsTable(value => !value)} aria-pressed={asTable} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-violet-500">
          <Table2 size={13} /> {asTable ? "Chart" : "Table"}
        </button>
      </div>
      {legend && !asTable && <div className="mt-3">{legend}</div>}
      <div className="mt-3">
        {asTable ? (
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-white text-slate-500"><tr>{table.columns.map(column => <th key={column} className="py-1.5 pr-3 font-semibold">{column}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">{table.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex} className={`py-1.5 pr-3 ${cellIndex ? "tabular-nums" : ""}`}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

/** Lines over a shared x axis of category labels (days). Crosshair + tooltip; end-of-line labels. */
export function LineChart({ labels, series, height = 220, formatLabel = (value: string) => value }: { labels: string[]; series: { key: string; label: string; color: string; values: number[] }[]; height?: number; formatLabel?: (value: string) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const margin = { top: 10, right: 72, bottom: 26, left: 32 };
  const innerW = Math.max(0, width - margin.left - margin.right);
  const innerH = height - margin.top - margin.bottom;
  const { top, ticks } = niceTicks(Math.max(0, ...series.flatMap(item => item.values)));
  const x = (index: number) => margin.left + (labels.length > 1 ? (index / (labels.length - 1)) * innerW : innerW / 2);
  const y = (value: number) => margin.top + innerH - (value / top) * innerH;
  const every = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(innerW / 64))));
  const last = labels.length - 1;
  // End labels are offset apart only when they would touch; beyond that the legend carries identity.
  const ends = series.map(item => ({ ...item, y: y(item.values[last] ?? 0) }));
  if (ends.length === 2 && Math.abs(ends[0].y - ends[1].y) < 14) {
    const middle = (ends[0].y + ends[1].y) / 2;
    const [upper, lower] = ends[0].y <= ends[1].y ? [0, 1] : [1, 0];
    ends[upper].y = middle - 7;
    ends[lower].y = middle + 7;
  }
  const tip: Tip = hover === null ? null : { x: x(hover), y: Math.min(...series.map(item => y(item.values[hover]))), title: formatLabel(labels[hover]), lines: series.map(item => ({ color: item.color, label: item.label, value: String(item.values[hover]) })) };

  return (
    <div ref={ref} className="relative" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={series.map(item => `${item.label}: ${item.values.reduce((a, b) => a + b, 0)} total`).join(", ")}
          onMouseMove={event => {
            const box = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - box.left - margin.left) / Math.max(1, innerW);
            setHover(Math.max(0, Math.min(last, Math.round(ratio * last))));
          }}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map(tick => (
            <g key={tick}>
              <line x1={margin.left} x2={margin.left + innerW} y1={y(tick)} y2={y(tick)} stroke={vizColors.grid} strokeWidth={1} />
              <text x={margin.left - 6} y={y(tick)} dy="0.32em" textAnchor="end" fontSize={11} fill={vizColors.textMuted}>{tick.toLocaleString()}</text>
            </g>
          ))}
          {labels.map((label, index) => (index % every === 0 || index === last) && (index === last || last - index >= every / 2) ? (
            <text key={label} x={x(index)} y={height - 6} textAnchor="middle" fontSize={11} fill={vizColors.textMuted}>{formatLabel(label)}</text>
          ) : null)}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={margin.top} y2={margin.top + innerH} stroke={vizColors.textMuted} strokeWidth={1} />}
          {series.map(item => (
            <g key={item.key}>
              <path d={item.values.map((value, index) => `${index ? "L" : "M"}${x(index)},${y(value)}`).join(" ")} fill="none" stroke={item.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {hover !== null && <circle cx={x(hover)} cy={y(item.values[hover])} r={4} fill={item.color} stroke={vizColors.surface} strokeWidth={2} />}
              <circle cx={x(last)} cy={y(item.values[last] ?? 0)} r={4} fill={item.color} stroke={vizColors.surface} strokeWidth={2} />
            </g>
          ))}
          {ends.map(item => (
            <text key={item.key} x={x(last) + 8} y={item.y} dy="0.32em" fontSize={11} fill={vizColors.textSecondary}>{item.label} <tspan fontWeight={600} fill={vizColors.textPrimary}>{item.values[last] ?? 0}</tspan></text>
          ))}
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

/** Horizontal bars. One series unless `keys` is given, in which case each bar is a stack of those keys. */
export function BarChart({ rows, keys, color = vizColors.series1, onSelect }: { rows: { label: string; values: Record<string, number> }[]; keys?: { key: string; label: string; color: string }[]; color?: string; onSelect?: (label: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const stack = keys ?? [{ key: "value", label: "Bugs", color }];
  const labelW = Math.min(150, Math.max(70, width * 0.3));
  const bar = 18;
  const rowH = 30;
  const height = rows.length * rowH + 4;
  const totals = rows.map(row => stack.reduce((sum, item) => sum + (row.values[item.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const scale = (value: number) => (value / max) * Math.max(0, width - labelW - 44);
  const gap = 2;

  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={rows.map((row, index) => `${row.label}: ${totals[index]}`).join(", ")} onMouseLeave={() => setTip(null)}>
          <line x1={labelW} x2={labelW} y1={0} y2={height} stroke={vizColors.grid} strokeWidth={1} />
          {rows.map((row, index) => {
            const top = index * rowH + (rowH - bar) / 2;
            let cursor = labelW;
            const segments = stack.filter(item => (row.values[item.key] ?? 0) > 0);
            return (
              <g key={row.label} className={onSelect ? "cursor-pointer" : ""} onClick={() => onSelect?.(row.label)}>
                <text x={labelW - 8} y={top + bar / 2} dy="0.32em" textAnchor="end" fontSize={12} fill={vizColors.textSecondary}>{row.label.length > 22 ? `${row.label.slice(0, 21)}…` : row.label}</text>
                {segments.map((item, position) => {
                  const value = row.values[item.key];
                  const full = scale(value);
                  const w = Math.max(0, full - (position < segments.length - 1 ? gap : 0));
                  const start = cursor;
                  cursor += full;
                  const isEnd = position === segments.length - 1;
                  return (
                    <path
                      key={item.key}
                      d={isEnd ? barPath(start, top, w, bar, true) : `M${start},${top} h${w} v${bar} h${-w} Z`}
                      fill={item.color}
                      onMouseMove={event => {
                        const box = (event.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                        setTip({ x: event.clientX - box.left, y: event.clientY - box.top, title: row.label, lines: keys ? [{ color: item.color, label: item.label, value: String(value) }, { label: "Total", value: String(totals[index]) }] : [{ label: item.label, value: String(value) }] });
                      }}
                    />
                  );
                })}
                {/* Transparent full-row hit target, so zero-length bars still answer hover. */}
                <rect x={0} y={index * rowH} width={width} height={rowH} fill="transparent" onMouseMove={event => {
                  if (segments.length) return;
                  const box = (event.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setTip({ x: event.clientX - box.left, y: event.clientY - box.top, title: row.label, lines: [{ label: "Bugs", value: "0" }] });
                }} style={{ pointerEvents: segments.length ? "none" : "auto" }} />
                <text x={labelW + scale(totals[index]) + 6} y={top + bar / 2} dy="0.32em" fontSize={12} fontWeight={600} fill={vizColors.textPrimary}>{totals[index]}</text>
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

/** Vertical columns for an ordered category (age buckets). Value on each cap. */
export function ColumnChart({ rows, color = vizColors.series1, height = 200 }: { rows: { label: string; value: number }[]; color?: string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const margin = { top: 18, bottom: 24 };
  const innerH = height - margin.top - margin.bottom;
  const slot = width / Math.max(1, rows.length);
  const barW = Math.min(24, slot * 0.6);
  const max = Math.max(1, ...rows.map(row => row.value));
  return (
    <div ref={ref} className="relative" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={rows.map(row => `${row.label}: ${row.value}`).join(", ")} onMouseLeave={() => setTip(null)}>
          <line x1={0} x2={width} y1={margin.top + innerH} y2={margin.top + innerH} stroke={vizColors.grid} strokeWidth={1} />
          {rows.map((row, index) => {
            const h = (row.value / max) * innerH;
            const cx = slot * index + slot / 2;
            return (
              <g key={row.label}>
                <rect x={slot * index} y={0} width={slot} height={height} fill="transparent" onMouseMove={event => {
                  const box = (event.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setTip({ x: event.clientX - box.left, y: event.clientY - box.top, title: row.label, lines: [{ label: "Open bugs", value: String(row.value) }] });
                }} />
                {row.value > 0 && <path d={barPath(cx - barW / 2, margin.top + innerH - h, barW, h, false)} fill={color} pointerEvents="none" />}
                <text x={cx} y={margin.top + innerH - h - 5} textAnchor="middle" fontSize={12} fontWeight={600} fill={vizColors.textPrimary} pointerEvents="none">{row.value}</text>
                <text x={cx} y={height - 6} textAnchor="middle" fontSize={11} fill={vizColors.textMuted} pointerEvents="none">{row.label}</text>
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

/** Stat tile: sentence-case label, a compact value, and an optional note. */
export function StatTile({ label, value, note, tone = "default", icon }: { label: string; value: string; note?: string; tone?: "default" | "critical" | "warning"; icon?: ReactNode }) {
  const toneClass = tone === "critical" ? "text-rose-700" : tone === "warning" ? "text-amber-800" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-slate-500">{icon}{label}</p>
      <p className={`mt-1 font-display text-2xl font-bold tabular-nums ${toneClass}`}>{value}</p>
      {note && <p className="text-[11px] text-slate-400">{note}</p>}
    </div>
  );
}
