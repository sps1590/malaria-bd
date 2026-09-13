"use client";

import { useEffect, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PopoutCard } from "@/components/ChartTools";
import { GRID, SERIES, axisTick, fmtInt, fmtNum, tooltipValue } from "@/lib/chart-theme";
import type { NspYear } from "@/lib/nsp";

interface NspResponse {
  available: boolean;
  note?: string;
  source?: string;
  scope?: string;
  notes?: Record<string, string>;
  years?: NspYear[];
}

/** NSP targets vs actual vs model forecast for the 13 at-risk districts or one district. */
export default function NspSection({ level, areaName }: { level: string; areaName: string }) {
  const [data, setData] = useState<{ id: string; body: NspResponse } | null>(null);
  const id = level === "district" ? `district|${areaName}` : level === "national" ? "national" : `other|${areaName}`;

  useEffect(() => {
    if (id.startsWith("other")) return;
    let cancelled = false;
    const qs = id.startsWith("district") ? `?district=${encodeURIComponent(id.split("|")[1])}` : "";
    fetch(`/api/insights/nsp${qs}`)
      .then((r) => r.json() as Promise<NspResponse>)
      .then((body) => !cancelled && setData({ id, body }))
      .catch(() => !cancelled && setData({ id, body: { available: false, note: "Failed to load NSP targets." } }));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (id.startsWith("other")) {
    return (
      <p className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600">
        NSP targets and population denominators are set for the 13 at-risk districts and for each district — choose Bangladesh or a district to compare.
      </p>
    );
  }
  const body = data?.id === id ? data.body : null;
  if (!body) return <p className="text-sm text-slate-500">Loading NSP targets…</p>;
  if (!body.available || !body.years) return <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">{body.note}</p>;

  const rows = body.years.filter((y) => y.year >= 2020);
  return (
    <PopoutCard
      title={`National Strategic Plan targets vs actual and forecast — ${body.scope}`}
      downloadName={`nsp-targets-${body.scope}`}
      className="border-violet-200 bg-gradient-to-br from-violet-50 to-white"
      bodyClassName="space-y-3"
      headerExtra={<p className="text-[11px] text-slate-600">Source file: <b>{body.source}</b></p>}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-64">
          <p className="mb-1 text-xs font-medium text-slate-600">Confirmed cases per year</p>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 4, right: 8, bottom: 16, left: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis dataKey="year" tick={axisTick} />
              <YAxis tick={axisTick} width={52} />
              <Tooltip formatter={tooltipValue} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="actual_cases" name="Actual (reported)" fill={SERIES[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              <Line dataKey="nsp_cases" name="NSP target" stroke={SERIES[1]} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              <Line dataKey="expected_cases" name="Actual + model forecast" stroke={SERIES[2]} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="h-64">
          <p className="mb-1 text-xs font-medium text-slate-600">API — cases per 1,000 population at risk</p>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 16, left: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis dataKey="year" tick={axisTick} />
              <YAxis tick={axisTick} width={44} />
              <Tooltip formatter={tooltipValue} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line dataKey="api_actual" name="Actual API" stroke={SERIES[0]} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              <Line dataKey="nsp_api" name="NSP API target" stroke={SERIES[1]} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Compact core table (left) plus a per-metric Actual/Target summary (right) — avoids the
          horizontal scroll of one wide table by grouping each metric's actual and target together. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-1 pr-3 font-medium">Year</th>
                <th className="py-1 pr-3 text-right font-medium">Population</th>
                <th className="py-1 pr-3 text-right font-medium">Actual cases</th>
                <th className="py-1 pr-3 text-right font-medium">NSP target</th>
                <th className="py-1 text-right font-medium">Expected*</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((y) => {
                const onTrack = y.expected_cases !== null && y.nsp_cases !== null ? y.expected_cases <= y.nsp_cases : null;
                return (
                  <tr key={y.year} className="border-t border-violet-100 tabular-nums">
                    <td className="py-1 pr-3">{y.year}{y.months_reported > 0 && y.months_reported < 12 ? <span className="text-slate-400"> ({y.months_reported} mo)</span> : null}</td>
                    <td className="py-1 pr-3 text-right">{fmtInt(y.population)}</td>
                    <td className="py-1 pr-3 text-right">{fmtInt(y.actual_cases)}</td>
                    <td className="py-1 pr-3 text-right">{fmtInt(y.nsp_cases)}</td>
                    <td className={`py-1 text-right ${onTrack === null ? "" : onTrack ? "text-emerald-700" : "text-rose-700"}`}>{fmtInt(y.expected_cases)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NspMetricColumn label="API" rows={rows} actual={(y) => fmtNum(y.api_actual, 2)} target={(y) => fmtNum(y.nsp_api, 2)} />
          <NspMetricColumn label="ABER" rows={rows} actual={(y) => (y.aber_actual_pct === null ? "—" : `${fmtNum(y.aber_actual_pct, 1)}%`)} target={(y) => (y.nsp_aber_pct === null ? "—" : `${fmtNum(y.nsp_aber_pct, 1)}%`)} />
          <NspMetricColumn label="Tests" rows={rows} actual={(y) => fmtInt(y.actual_tests)} target={(y) => fmtInt(y.nsp_tests)} />
          <NspMetricColumn label="Deaths" danger rows={rows} actual={(y) => fmtInt(y.actual_deaths)} target={(y) => fmtNum(y.nsp_deaths, 1)} />
        </div>
      </div>
      <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-slate-600">
        {Object.values(body.notes ?? {}).map((n) => <li key={n}>{n}</li>)}
        <li>* Expected = actual reported cases + model forecast for the rest of that year (green = at or below the NSP target, red = above).</li>
      </ul>
    </PopoutCard>
  );
}

/** One metric's Actual/Target pair, stacked per year — the compact alternative to a 13-column table. */
function NspMetricColumn({
  label,
  rows,
  actual,
  target,
  danger = false,
}: {
  label: string;
  rows: NspYear[];
  actual: (y: NspYear) => string;
  target: (y: NspYear) => string;
  danger?: boolean;
}) {
  return (
    <div>
      <h4 className={`text-xs font-semibold uppercase tracking-wide ${danger ? "text-red-700" : "text-slate-600"}`}>{label}</h4>
      <ul className="mt-1.5 space-y-2">
        {rows.map((y) => (
          <li key={y.year} className="text-xs tabular-nums">
            <div className="text-[10px] text-slate-400">{y.year}</div>
            <div className={danger ? "font-medium text-red-700" : "text-slate-800"}>Actual: {actual(y)}</div>
            <div className="text-slate-500">Target: {target(y)}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
