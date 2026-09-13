"use client";

import { useEffect, useRef, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DownloadImageButton } from "@/components/ChartTools";
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
  const ref = useRef<HTMLElement>(null);
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
    <section ref={ref} className="space-y-3 rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">National Strategic Plan targets vs actual and forecast — {body.scope}</h3>
          <p className="text-[11px] text-slate-600">Source file: <b>{body.source}</b></p>
        </div>
        <DownloadImageButton target={ref} filename={`nsp-targets-${body.scope}`} />
      </div>

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

      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-1 pr-3 font-medium">Year</th>
              <th className="py-1 pr-3 text-right font-medium">Population</th>
              <th className="py-1 pr-3 text-right font-medium">Actual cases</th>
              <th className="py-1 pr-3 text-right font-medium">NSP target</th>
              <th className="py-1 pr-3 text-right font-medium">Expected*</th>
              <th className="py-1 pr-3 text-right font-medium">API actual</th>
              <th className="py-1 pr-3 text-right font-medium">API target</th>
              <th className="py-1 pr-3 text-right font-medium">ABER actual</th>
              <th className="py-1 pr-3 text-right font-medium">ABER target</th>
              <th className="py-1 pr-3 text-right font-medium">Tests actual</th>
              <th className="py-1 pr-3 text-right font-medium">Tests target</th>
              <th className="py-1 pr-3 text-right font-medium text-red-700">Deaths actual</th>
              <th className="py-1 text-right font-medium text-red-700">Deaths target</th>
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
                  <td className={`py-1 pr-3 text-right ${onTrack === null ? "" : onTrack ? "text-emerald-700" : "text-rose-700"}`}>{fmtInt(y.expected_cases)}</td>
                  <td className="py-1 pr-3 text-right">{fmtNum(y.api_actual, 2)}</td>
                  <td className="py-1 pr-3 text-right">{fmtNum(y.nsp_api, 2)}</td>
                  <td className="py-1 pr-3 text-right">{y.aber_actual_pct === null ? "—" : `${fmtNum(y.aber_actual_pct, 1)}%`}</td>
                  <td className="py-1 pr-3 text-right">{y.nsp_aber_pct === null ? "—" : `${fmtNum(y.nsp_aber_pct, 1)}%`}</td>
                  <td className="py-1 pr-3 text-right">{fmtInt(y.actual_tests)}</td>
                  <td className="py-1 pr-3 text-right">{fmtInt(y.nsp_tests)}</td>
                  <td className="py-1 pr-3 text-right text-red-700">{fmtInt(y.actual_deaths)}</td>
                  <td className="py-1 text-right text-red-700">{fmtNum(y.nsp_deaths, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-slate-600">
        {Object.values(body.notes ?? {}).map((n) => <li key={n}>{n}</li>)}
        <li>* Expected = actual reported cases + model forecast for the rest of that year (green = at or below the NSP target, red = above).</li>
      </ul>
    </section>
  );
}
