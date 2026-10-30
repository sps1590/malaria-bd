"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { GRID, SERIES, axisTick, fmtInt, fmtNum } from "@/lib/chart-theme";
import type { Cell, CellFormat, ChartSpec, TableSpec } from "@/lib/analyst/types";

export function formatCell(v: Cell | undefined, format: CellFormat | undefined): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  switch (format) {
    case "int": return fmtInt(v);
    case "d1": return fmtNum(v, 1);
    case "d2": return fmtNum(v, 2);
    case "pct1": return `${fmtNum(v, 1)}%`;
    case "pct2": return `${fmtNum(v, 2)}%`;
    case "signed_pct": return `${v > 0 ? "▲" : v < 0 ? "▼" : ""} ${fmtNum(Math.abs(v), Math.abs(v) < 10 ? 1 : 0)}%`.trim();
    default: return Number.isInteger(v) ? fmtInt(v) : fmtNum(v, 2);
  }
}

const valueFormatter = (format: ChartSpec["format"]) => (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return format === "int" ? fmtInt(n) : format === "d1" ? fmtNum(n, 1) : format === "d2" ? fmtNum(n, 2) : format === "pct1" ? `${fmtNum(n, 1)}%` : `${fmtNum(n, 2)}%`;
};

/* ------------------------------ table ------------------------------ */

export function DataTable({ table, initialRows = 10 }: { table: TableSpec; initialRows?: number }) {
  const [all, setAll] = useState(false);
  const rows = all ? table.rows : table.rows.slice(0, initialRows);
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="max-h-96 overflow-auto">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-slate-600">
            <tr>
              {table.columns.map((c, i) => (
                <th key={c.key} className={`whitespace-nowrap border-b border-slate-200 px-3 py-2 font-semibold ${i === 0 || c.format === "text" ? "text-left" : "text-right"}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="odd:bg-white even:bg-slate-50/60">
                {table.columns.map((c, i) => {
                  const v = r[c.key];
                  const text = formatCell(v, c.format);
                  const left = i === 0 || c.format === "text";
                  const change = c.format === "signed_pct" && typeof v === "number" ? (v > 0 ? "text-rose-700" : v < 0 ? "text-emerald-700" : "") : typeof v === "string" && /^▲/.test(v) ? "text-rose-700" : typeof v === "string" && /^▼/.test(v) ? "text-emerald-700" : "";
                  return (
                    <td key={c.key} className={`whitespace-nowrap border-b border-slate-100 px-3 py-1.5 ${left ? "text-left" : "text-right tabular-nums"} ${change}`}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > initialRows && (
        <button type="button" onClick={() => setAll((a) => !a)} className="w-full border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50">
          {all ? "Show fewer rows" : `Show all ${table.rows.length} rows`}
        </button>
      )}
    </div>
  );
}

export function tableToCsv(table: TableSpec): string {
  const esc = (v: Cell | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [table.columns.map((c) => esc(c.label)).join(","), ...table.rows.map((r) => table.columns.map((c) => esc(r[c.key])).join(","))].join("\n");
}

/* ------------------------------ chart ------------------------------ */

function seriesStyle(key: string, index: number): { color: string; dash?: string; width: number; opacity: number } {
  if (key === "predicted") return { color: SERIES[1], dash: "6 4", width: 2.4, opacity: 1 };
  if (key === "lo80" || key === "hi80") return { color: SERIES[1], dash: "2 3", width: 1.2, opacity: 0.55 };
  if (key === "actual") return { color: SERIES[0], width: 2.4, opacity: 1 };
  return { color: SERIES[index % SERIES.length], width: 2.4, opacity: 1 };
}

export function DataChart({ chart }: { chart: ChartSpec }) {
  const fmt = useMemo(() => valueFormatter(chart.format), [chart.format]);
  const legend = chart.series.length > 1;
  const common = { data: chart.rows as Record<string, unknown>[], margin: { top: 8, right: 16, bottom: 0, left: 0 } };
  const yWidth = chart.format === "int" ? 52 : 56;

  if (chart.kind === "hbar") {
    const height = Math.max(200, chart.rows.length * 30 + 50);
    const longest = Math.max(...chart.rows.map((r) => String(r[chart.xKey] ?? "").length), 6);
    const labelWidth = Math.min(190, Math.max(70, longest * 6.4));
    return (
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart layout="vertical" data={chart.rows as Record<string, unknown>[]} margin={{ top: 4, right: 56, bottom: 0, left: 0 }}>
            <CartesianGrid horizontal={false} stroke={GRID} />
            <XAxis type="number" tick={axisTick} tickFormatter={(v) => fmt(v)} />
            <YAxis type="category" dataKey={chart.xKey} width={labelWidth} tick={{ ...axisTick, fill: "#52514e" }} interval={0} />
            <Tooltip formatter={(v) => fmt(v)} cursor={{ fill: "rgba(42,120,214,0.06)" }} />
            {chart.series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={seriesStyle(s.key, i).color} radius={[0, 4, 4, 0]} isAnimationActive={false} maxBarSize={20}>
                {chart.rows.length <= 14 && <LabelList dataKey={s.key} position="right" formatter={(v) => fmt(v)} style={{ fontSize: 11, fill: "#52514e" }} />}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div style={{ height: 280 }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {chart.kind === "line" ? (
          <LineChart {...common}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey={chart.xKey} tick={axisTick} interval="preserveStartEnd" minTickGap={28} />
            <YAxis tick={axisTick} width={yWidth} tickFormatter={(v) => fmt(v)} />
            <Tooltip formatter={(v) => fmt(v)} />
            {legend && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {chart.series.map((s, i) => {
              const st = seriesStyle(s.key, i);
              return <Line key={s.key} dataKey={s.key} name={s.label} stroke={st.color} strokeWidth={st.width} strokeDasharray={st.dash} strokeOpacity={st.opacity} dot={chart.rows.length <= 18 && st.opacity === 1} isAnimationActive={false} connectNulls={false} />;
            })}
          </LineChart>
        ) : (
          <BarChart {...common}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey={chart.xKey} tick={axisTick} interval={chart.rows.length > 12 ? "preserveStartEnd" : 0} minTickGap={12} />
            <YAxis tick={axisTick} width={yWidth} tickFormatter={(v) => fmt(v)} />
            <Tooltip formatter={(v) => fmt(v)} cursor={{ fill: "rgba(42,120,214,0.06)" }} />
            {legend && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {chart.series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={seriesStyle(s.key, i).color} radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={44}>
                {chart.rows.length <= 8 && chart.series.length === 1 && <LabelList dataKey={s.key} position="top" formatter={(v) => fmt(v)} style={{ fontSize: 11, fill: "#52514e" }} />}
              </Bar>
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
