"use client";

import type { RefObject } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { GRID, SERIES, SURFACE, axisTick } from "@/lib/chart-theme";

export type ChartKind = "column" | "bar" | "stacked" | "line" | "area" | "pie";

/** What the Pivot's rows/columns/chosen value look like once flattened for a chart. */
export interface ChartModel {
  /** One entry per plotted series; `key` is the property name used in `rows`. */
  series: { key: string; label: string }[];
  /** One entry per category (the Rows): `{ name, <series key>: value }`. */
  rows: Record<string, string | number | null>[];
  /** Slices for the pie view (top slices + "Other"). */
  pie: { name: string; value: number }[];
}

const OTHER_COLOR = "#a8a79f";
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const shorten = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Stacking and pie slices only make sense for counts (they add up); rates are drawn side by side. */
export const ADDITIVE_ONLY: ChartKind[] = ["stacked", "pie"];

export function PivotChart({
  kind,
  model,
  title,
  format,
  captureRef,
}: {
  kind: ChartKind;
  model: ChartModel;
  title: string;
  format: (v: number | null) => string;
  /** The element rasterized by the PNG/PDF export — includes the title so the picture stands alone. */
  captureRef: RefObject<HTMLDivElement | null>;
}) {
  const n = model.rows.length;
  const multi = model.series.length > 1;
  const tooltip = (v: unknown) => format(typeof v === "number" ? v : null);
  const margin = { top: 8, right: 16, bottom: 4, left: n > 6 ? 36 : 4 };

  let body;
  let height = 440;
  if (kind === "pie") {
    body = (
      <PieChart>
        <Tooltip formatter={tooltip} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Pie
          data={model.pie}
          dataKey="value"
          nameKey="name"
          innerRadius="42%"
          outerRadius="78%"
          paddingAngle={1}
          stroke={SURFACE}
          strokeWidth={2}
          isAnimationActive={false}
          label={(p: { percent?: number }) => (p.percent && p.percent >= 0.04 ? `${Math.round(p.percent * 100)}%` : "")}
          labelLine={false}
        >
          {model.pie.map((s, i) => (
            <Cell key={s.name} fill={s.name === "Other" ? OTHER_COLOR : SERIES[i % SERIES.length]} />
          ))}
        </Pie>
      </PieChart>
    );
  } else if (kind === "bar") {
    height = Math.max(440, n * (model.series.length * 15 + 12) + 70);
    const yWidth = Math.min(220, Math.max(80, Math.max(...model.rows.map((r) => String(r.name).length), 0) * 6.2));
    body = (
      <BarChart data={model.rows} layout="vertical" margin={margin}>
        <CartesianGrid horizontal={false} stroke={GRID} />
        <XAxis type="number" tick={axisTick} tickFormatter={(v: number) => COMPACT.format(v)} />
        <YAxis type="category" dataKey="name" tick={axisTick} width={yWidth} interval={0} tickFormatter={(v: string) => shorten(String(v), 34)} />
        <Tooltip formatter={tooltip} />
        {multi && <Legend verticalAlign="top" wrapperStyle={{ fontSize: 12 }} />}
        {model.series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} fill={SERIES[i % SERIES.length]} radius={[0, 3, 3, 0]} isAnimationActive={false} />
        ))}
      </BarChart>
    );
  } else if (kind === "line" || kind === "area") {
    const Chart = kind === "line" ? LineChart : AreaChart;
    body = (
      <Chart data={model.rows} margin={margin}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="name" tick={axisTick} interval="preserveStartEnd" angle={n > 6 ? -35 : 0} textAnchor={n > 6 ? "end" : "middle"} height={n > 6 ? 80 : 30} tickFormatter={(v: string) => shorten(String(v), 22)} />
        <YAxis tick={axisTick} width={52} tickFormatter={(v: number) => COMPACT.format(v)} />
        <Tooltip formatter={tooltip} />
        {multi && <Legend verticalAlign="top" wrapperStyle={{ fontSize: 12 }} />}
        {model.series.map((s, i) =>
          kind === "line" ? (
            <Line key={s.key} dataKey={s.key} name={s.label} stroke={SERIES[i % SERIES.length]} strokeWidth={2} dot={n <= 40 ? { r: 3, stroke: SURFACE, strokeWidth: 1 } : false} connectNulls isAnimationActive={false} />
          ) : (
            <Area key={s.key} dataKey={s.key} name={s.label} stroke={SERIES[i % SERIES.length]} fill={SERIES[i % SERIES.length]} fillOpacity={0.18} strokeWidth={2} connectNulls isAnimationActive={false} />
          ),
        )}
      </Chart>
    );
  } else {
    // column / stacked
    body = (
      <BarChart data={model.rows} margin={margin}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="name" tick={axisTick} interval={0} angle={n > 6 ? -35 : 0} textAnchor={n > 6 ? "end" : "middle"} height={n > 6 ? 80 : 30} tickFormatter={(v: string) => shorten(String(v), 22)} />
        <YAxis tick={axisTick} width={52} tickFormatter={(v: number) => COMPACT.format(v)} />
        <Tooltip formatter={tooltip} />
        {multi && <Legend verticalAlign="top" wrapperStyle={{ fontSize: 12 }} />}
        {model.series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={SERIES[i % SERIES.length]}
            stackId={kind === "stacked" ? "s" : undefined}
            stroke={kind === "stacked" ? SURFACE : undefined}
            strokeWidth={kind === "stacked" ? 1 : 0}
            radius={kind === "stacked" ? 0 : [3, 3, 0, 0]}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    );
  }

  return (
    <div ref={captureRef} className="bg-white p-3">
      <h4 className="mb-2 text-sm font-semibold text-slate-800">{title}</h4>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {body}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
