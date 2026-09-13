"use client";

import { useEffect, useMemo, useState } from "react";
import { PopoutCard } from "@/components/ChartTools";
import NspSection from "@/components/NspSection";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { GRID, MODEL_LABEL, SERIES, axisTick, divergingColor, fmtInt, fmtNum, tooltipValue } from "@/lib/chart-theme";
import { MONTHS } from "@/lib/malaria-metrics";

interface AreaOption { level: string; area_key: string; area_name: string; accuracy_pct: number | null; accuracy_3m_pct: number | null; model: string }
interface Run {
  model: string; accuracy_pct: number | null; accuracy_3m_pct: number | null; mae: number | null; backtest_origins: number;
  train_start: string; train_end: string; notes: string; created_at: string;
  candidates: Record<string, { accuracy_1m_pct?: number | null; accuracy_3m_pct?: number | null; mae_1m: number }>;
}
interface TargetData {
  run: Run | null;
  forecast: { year: number; month: number; yhat: number; lo80: number; hi80: number; lo95: number; hi95: number }[];
  backtest: { year: number; month: number; horizon: number; actual: number; predicted: number }[];
}
interface ForecastResponse {
  available: boolean;
  areas: AreaOption[];
  selected?: AreaOption;
  history?: { year: number; month: number; cases: number; deaths: number }[];
  cases?: TargetData;
  deaths?: TargetData;
  live?: { target: string; horizon: number; months: number; accuracy_pct: number | null; mae: number }[];
  error?: string;
}
interface ClimateResponse {
  available: boolean;
  note?: string;
  scope?: string;
  source?: string;
  series: { period: string; cases: number; rainfall_mm: number | null; temp_mean_c: number | null; humidity_pct: number | null; dew_point_c: number | null }[];
  correlation: { available?: boolean; method?: string; strongest?: { variable: string; lag_months: number; spearman_rho: number | null }; results?: { variable: string; lag_months: number; spearman_rho: number | null; months: number }[] };
}

const period = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const HISTORY_MONTHS = 36;

function buildRows(history: ForecastResponse["history"], data: TargetData | undefined, key: "cases" | "deaths") {
  const rows = new Map<string, Record<string, number | number[] | string | null>>();
  const recent = (history ?? []).slice(-HISTORY_MONTHS);
  for (const h of recent) rows.set(period(h.year, h.month), { period: period(h.year, h.month), actual: h[key] });
  for (const b of data?.backtest ?? []) {
    if (b.horizon !== 1) continue;
    const row = rows.get(period(b.year, b.month));
    if (row) row.backtest = Math.round(b.predicted * 10) / 10;
  }
  const last = recent[recent.length - 1];
  if (last && data?.forecast.length) {
    const anchor = rows.get(period(last.year, last.month));
    if (anchor) {
      anchor.forecast = last[key];
      anchor.band80 = [last[key], last[key]];
      anchor.band95 = [last[key], last[key]];
    }
  }
  for (const f of data?.forecast ?? []) {
    rows.set(period(f.year, f.month), {
      period: period(f.year, f.month),
      forecast: Math.round(f.yhat * 10) / 10,
      band80: [Math.round(f.lo80), Math.round(f.hi80)],
      band95: [Math.round(f.lo95), Math.round(f.hi95)],
    });
  }
  return [...rows.values()].sort((a, b) => String(a.period).localeCompare(String(b.period)));
}

export default function ForecastTab() {
  const [selection, setSelection] = useState({ level: "national", key: "bangladesh" });
  const [data, setData] = useState<ForecastResponse | null>(null);
  const [climate, setClimate] = useState<ClimateResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/insights/forecast?level=${encodeURIComponent(selection.level)}&key=${encodeURIComponent(selection.key)}`)
      .then((r) => r.json() as Promise<ForecastResponse>)
      .then((j) => {
        if (cancelled) return;
        setData(j);
        setLoading(false);
        const area = j.selected;
        const qs = area && area.level !== "national" ? `area=${encodeURIComponent(area.area_name)}&level=${area.level}` : "level=national";
        return fetch(`/api/insights/climate?${qs}&years=6`).then((r) => r.json() as Promise<ClimateResponse>).then((c) => !cancelled && setClimate(c));
      })
      .catch(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selection]);

  const caseRows = useMemo(() => buildRows(data?.history, data?.cases, "cases"), [data]);
  const deathRows = useMemo(() => buildRows(data?.history, data?.deaths, "deaths"), [data]);

  if (loading && !data) return <p className="text-sm text-slate-500">Loading forecasts…</p>;
  if (!data?.available) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
        No forecasts yet. Run <code>python pipeline/forecast.py</code> (it also runs daily on GitHub Actions).
      </div>
    );
  }

  const run = data.cases?.run;
  const deathRun = data.deaths?.run;
  const levels = ["national", "division", "district"] as const;
  const candidates = run ? Object.entries(run.candidates).sort((a, b) => (b[1].accuracy_1m_pct ?? -1) - (a[1].accuracy_1m_pct ?? -1)) : [];

  return (
    <div className={`space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          Area
          <select
            value={`${selection.level}|${selection.key}`}
            onChange={(e) => {
              const [level, key] = e.target.value.split("|");
              setLoading(true);
              setSelection({ level, key });
            }}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            {levels.map((level) => (
              <optgroup key={level} label={level[0].toUpperCase() + level.slice(1)}>
                {data.areas.filter((a) => a.level === level).map((a) => (
                  <option key={a.area_key} value={`${a.level}|${a.area_key}`}>{a.area_name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <span className="text-xs text-slate-500">Forecasts are retrained daily after the MIS sync; accuracy is re-measured every run.</span>
      </div>

      {run && (
        <PopoutCard
          title={`Selected model · ${data.selected?.area_name}`}
          downloadName={`forecast-model-${data.selected?.area_name}`}
          className="border-indigo-200 bg-gradient-to-br from-indigo-50 to-white"
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div>
              <h2 className="text-lg font-bold text-slate-900">{MODEL_LABEL[run.model] ?? run.model}</h2>
              <div className="mt-3 flex flex-wrap gap-6">
                <Metric value={run.accuracy_pct === null ? "—" : `${run.accuracy_pct}%`} label="1-month-ahead accuracy" />
                <Metric value={run.accuracy_3m_pct === null ? "—" : `${run.accuracy_3m_pct}%`} label="3-months-ahead accuracy" />
                <Metric value={fmtNum(run.mae, 0)} label="mean abs. error (cases/month)" />
              </div>
              <p className="mt-3 text-xs leading-relaxed text-slate-600">
                <b>Note:</b> {run.notes} Accuracy is measured honestly on forecasts made only with data available at the time; it is not tuned to a target.
                Trained on {run.train_start} → {run.train_end}.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="text-left text-slate-500">
                  <tr><th className="py-1 pr-3 font-medium">Model compared</th><th className="py-1 pr-3 text-right font-medium">1-month</th><th className="py-1 pr-3 text-right font-medium">3-month</th><th className="py-1 text-right font-medium">MAE</th></tr>
                </thead>
                <tbody>
                  {candidates.map(([name, c]) => (
                    <tr key={name} className={`border-t border-indigo-100 ${name === run.model ? "font-semibold text-indigo-900" : "text-slate-700"}`}>
                      <td className="py-1 pr-3">{name === run.model ? "✓ " : ""}{MODEL_LABEL[name] ?? name}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{c.accuracy_1m_pct ?? "—"}%</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{c.accuracy_3m_pct ?? "—"}%</td>
                      <td className="py-1 text-right tabular-nums">{fmtNum(c.mae_1m, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </PopoutCard>
      )}

      <ChartCard title={`Confirmed cases — actual, back-tested and forecast (${data.selected?.area_name})`} height={340}>
        <ComposedChart data={caseRows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="period" tick={axisTick} minTickGap={28} />
          <YAxis tick={axisTick} width={52} />
          <Tooltip formatter={tooltipValue} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area dataKey="band95" name="95% range" stroke="none" fill={SERIES[1]} fillOpacity={0.1} isAnimationActive={false} />
          <Area dataKey="band80" name="80% range" stroke="none" fill={SERIES[1]} fillOpacity={0.22} isAnimationActive={false} />
          <Line dataKey="actual" name="Actual cases" stroke={SERIES[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line dataKey="backtest" name="Model, 1 month ahead (back-test)" stroke={SERIES[2]} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          <Line dataKey="forecast" name="Forecast" stroke={SERIES[1]} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} isAnimationActive={false} />
        </ComposedChart>
      </ChartCard>

      <PopoutCard title="Forecasts vs real data — live tracking" className="border-emerald-200 bg-emerald-50/50" noDownload={!data.live?.length}>
        {data.live?.length ? (
          <table className="text-xs">
            <thead className="text-left text-slate-500">
              <tr><th className="py-1 pr-6 font-medium">Target</th><th className="py-1 pr-6 font-medium">Months ahead</th><th className="py-1 pr-6 text-right font-medium">Months compared</th><th className="py-1 pr-6 text-right font-medium">Real accuracy</th><th className="py-1 text-right font-medium">Mean abs. error</th></tr>
            </thead>
            <tbody>
              {data.live.map((l) => (
                <tr key={`${l.target}-${l.horizon}`} className="border-t border-emerald-100 tabular-nums">
                  <td className="py-1 pr-6">{l.target}</td>
                  <td className="py-1 pr-6">{l.horizon}</td>
                  <td className="py-1 pr-6 text-right">{l.months}</td>
                  <td className="py-1 pr-6 text-right font-semibold">{l.accuracy_pct === null ? "—" : `${l.accuracy_pct}%`}</td>
                  <td className="py-1 text-right">{fmtNum(l.mae, l.target === "deaths" ? 2 : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-slate-600">
            Tracking is on: every forecast is archived with the data month it was made from. When the MIS reports those months, the real error % appears
            here automatically, and each daily retrain re-tests all models on the newest data and switches to whichever is now most accurate.
          </p>
        )}
      </PopoutCard>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <ChartCard title="Deaths — actual and expected" height={260}
          note={deathRun ? `${MODEL_LABEL[deathRun.model] ?? deathRun.model}. ${deathRun.notes}` : undefined}>
          <ComposedChart data={deathRows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="period" tick={axisTick} minTickGap={28} />
            <YAxis tick={axisTick} width={36} allowDecimals={false} />
            <Tooltip formatter={tooltipValue} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area dataKey="band80" name="80% range" stroke="none" fill={SERIES[1]} fillOpacity={0.22} isAnimationActive={false} />
            <Bar dataKey="actual" name="Reported deaths" fill="#c81e1e" radius={[4, 4, 0, 0]} isAnimationActive={false} />
            <Line dataKey="forecast" name="Expected deaths" stroke="#c81e1e" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} isAnimationActive={false} />
          </ComposedChart>
        </ChartCard>

        <PopoutCard title={`Forecast table — next ${(data.cases?.forecast ?? []).length} months`}>
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr><th className="py-1 font-medium">Month</th><th className="py-1 text-right font-medium">Cases (80% range)</th><th className="py-1 text-right font-medium">Deaths (80% range)</th></tr>
            </thead>
            <tbody>
              {(data.cases?.forecast ?? []).map((f, i) => {
                const d = data.deaths?.forecast[i];
                return (
                  <tr key={period(f.year, f.month)} className="border-t border-slate-100">
                    <td className="py-1.5">{MONTHS[f.month - 1].slice(0, 3)} {f.year}</td>
                    <td className="py-1.5 text-right tabular-nums"><b>{fmtInt(f.yhat)}</b> <span className="text-xs text-slate-500">({fmtInt(f.lo80)}–{fmtInt(f.hi80)})</span></td>
                    <td className="py-1.5 text-right tabular-nums"><b>{d ? fmtNum(d.yhat, 1) : "—"}</b> <span className="text-xs text-slate-500">{d ? `(${fmtInt(d.lo80)}–${fmtInt(d.hi80)})` : ""}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </PopoutCard>
      </div>

      {data.selected && <NspSection level={data.selected.level} areaName={data.selected.area_name} />}

      <ClimateSection climate={climate} />
    </div>
  );
}

function ClimateSection({ climate }: { climate: ClimateResponse | null }) {
  if (!climate) return <p className="text-sm text-slate-500">Loading ERA5 climate…</p>;
  if (!climate.available) {
    return (
      <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        ERA5 climate data for this area is not loaded yet ({climate.note ?? "run python pipeline/era5.py"}).
      </p>
    );
  }
  const multiples = [
    { key: "cases", title: "Confirmed cases", color: SERIES[0], kind: "bar" as const, unit: "" },
    { key: "rainfall_mm", title: "Rainfall (mm / month)", color: SERIES[1], kind: "bar" as const, unit: " mm" },
    { key: "temp_mean_c", title: "Mean temperature (°C)", color: SERIES[2], kind: "line" as const, unit: " °C" },
    { key: "humidity_pct", title: "Relative humidity (%)", color: SERIES[3], kind: "line" as const, unit: "%" },
  ];
  const variables = ["rainfall_mm", "temp_mean_c", "humidity_pct", "dew_point_c", "soil_moisture_m3m3"];
  const variableLabel: Record<string, string> = {
    rainfall_mm: "Rainfall", temp_mean_c: "Temperature", humidity_pct: "Humidity", dew_point_c: "Dew point", soil_moisture_m3m3: "Soil moisture",
  };
  const results = climate.correlation.results ?? [];
  const rho = (variable: string, lag: number) => results.find((r) => r.variable === variable && r.lag_months === lag)?.spearman_rho ?? null;

  return (
    <PopoutCard
      title={`Climate and malaria — ${climate.scope}`}
      downloadName={`climate-${climate.scope}`}
      bodyClassName="space-y-3"
      headerExtra={<p className="text-xs text-slate-500">{climate.source}. Separate aligned panels (no shared scale); hover to compare months.</p>}
    >
      <div className="grid gap-3 md:grid-cols-2">
        {multiples.map((m) => (
          <div key={m.key} className="h-44">
            <p className="mb-1 text-xs font-medium text-slate-600">{m.title}</p>
            <ResponsiveContainer width="100%" height="100%">
              {m.kind === "bar" ? (
                <BarChart data={climate.series} syncId="climate" margin={{ top: 4, right: 8, bottom: 16, left: 0 }}>
                  <CartesianGrid vertical={false} stroke={GRID} />
                  <XAxis dataKey="period" tick={axisTick} minTickGap={40} />
                  <YAxis tick={axisTick} width={44} />
                  <Tooltip formatter={(v: unknown) => `${tooltipValue(v)}${m.unit}`} />
                  <Bar dataKey={m.key} name={m.title} fill={m.color} radius={[2, 2, 0, 0]} isAnimationActive={false} />
                </BarChart>
              ) : (
                <LineChart data={climate.series} syncId="climate" margin={{ top: 4, right: 8, bottom: 16, left: 0 }}>
                  <CartesianGrid vertical={false} stroke={GRID} />
                  <XAxis dataKey="period" tick={axisTick} minTickGap={40} />
                  <YAxis tick={axisTick} width={44} domain={["auto", "auto"]} />
                  <Tooltip formatter={(v: unknown) => `${tooltipValue(v)}${m.unit}`} />
                  <Line dataKey={m.key} name={m.title} stroke={m.color} strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        ))}
      </div>

      {results.length > 0 && (
        <div className="overflow-x-auto">
          <p className="mb-1 text-xs font-medium text-slate-600">
            Lagged correlation with cases (Spearman ρ; blue = negative, red = positive). Strongest:{" "}
            <b>{variableLabel[climate.correlation.strongest?.variable ?? ""] ?? "—"}</b> {climate.correlation.strongest?.lag_months} month(s) earlier, ρ = {climate.correlation.strongest?.spearman_rho}.
          </p>
          <table className="text-xs">
            <thead>
              <tr>
                <th className="px-2 py-1 text-left font-medium text-slate-500">Weather</th>
                {[0, 1, 2, 3].map((lag) => <th key={lag} className="px-3 py-1 font-medium text-slate-500">{lag === 0 ? "same month" : `${lag} mo earlier`}</th>)}
              </tr>
            </thead>
            <tbody>
              {variables.map((v) => (
                <tr key={v}>
                  <td className="px-2 py-1 text-slate-700">{variableLabel[v]}</td>
                  {[0, 1, 2, 3].map((lag) => {
                    const value = rho(v, lag);
                    return (
                      <td key={lag} className="border-2 border-white px-3 py-1 text-center tabular-nums text-slate-900" style={{ background: divergingColor(value) }}>
                        {value === null ? "—" : value.toFixed(2)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-slate-500">{climate.correlation.method}</p>
        </div>
      )}
    </PopoutCard>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="text-3xl font-bold text-slate-900">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function ChartCard({ title, height, note, children }: { title: string; height: number; note?: string; children: React.ReactElement }) {
  return (
    <PopoutCard title={title}>
      {(big) => (
        <>
          <div style={{ height: big ? "65vh" : height }}>
            <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
          </div>
          {note && <p className="mt-2 text-xs text-slate-500">{note}</p>}
        </>
      )}
    </PopoutCard>
  );
}
