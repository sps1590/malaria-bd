"use client";

import { useMemo, useState } from "react";
import { Area, Bar, BarChart, Brush, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PopoutCard } from "@/components/ChartTools";
import { GRID, INK_MUTED, SERIES, STATUS, SURFACE, axisTick, fmtInt, fmtNum, tooltipValue } from "@/lib/chart-theme";
import { mean, monthlyProfile, movingAverage, pctChange, seriesSignals } from "@/lib/epi-calc";
import { measureValue } from "@/lib/malaria-metrics";
import { ChartPanel, Delta, Note, Section, heatColor } from "./EpiShared";
import type { EpiModel } from "./model";

const Z_WARN = 2;
const Z_ALERT = 3;

export default function EpiTime({ m }: { m: EpiModel }) {
  const curve = useMemo(() => {
    const cases = m.series.map((p) => p.totals.cases);
    const ma = movingAverage(cases, 12);
    return m.series.map((p, i) => ({ label: p.label, cases: p.totals.cases, ma12: ma[i] === null ? null : Math.round(ma[i] as number) }));
  }, [m.series]);

  const signals = useMemo(() => seriesSignals(m.series, 36).map((s) => ({ ...s, label: m.series.find((p) => p.t === s.t)?.label ?? "", z: Math.round(s.z * 100) / 100, expected: Math.round(s.expected) })), [m.series]);
  const flagged = m.districtRows
    .filter((d) => d.signal && d.signal.z >= Z_WARN && d.signal.cases >= 5)
    .sort((a, b) => (b.signal?.z ?? 0) - (a.signal?.z ?? 0))
    .slice(0, 12);

  const cumulative = useMemo(() => {
    const cases = new Map(m.series.map((p) => [p.t, p.totals.cases]));
    const y = m.endemic.year;
    const run = (year: number, upTo: number) => {
      let s = 0;
      return Array.from({ length: 12 }, (_, i) => (i < upTo ? (s += cases.get(year * 12 + i) ?? 0) : null));
    };
    const current = run(y, m.endemic.latestMonth);
    const previous = run(y - 1, 12);
    const base = m.endemic.baselineYears.map((by) => run(by, 12) as number[]);
    return Array.from({ length: 12 }, (_, i) => ({
      label: m.endemic.months[i].label,
      current: current[i],
      previous: previous[i],
      baseline: base.length ? Math.round(mean(base.map((b) => b[i]))) : null,
    }));
  }, [m.series, m.endemic]);
  const ytdNow = cumulative[m.endemic.latestMonth - 1];
  const aboveThreshold = m.endemic.months.filter((c) => c.current !== null && c.current > c.threshold);
  const channel = m.endemic.months.map((c) => ({ ...c, band: [c.q1, c.q3] }));

  const species = useMemo(() => {
    const pf = monthlyProfile(m.series, m.latest, "pf");
    const pv = monthlyProfile(m.series, m.latest, "pv");
    return pf.map((x, i) => ({ label: x.label, pf: Math.round(x.value), pv: Math.round(pv[i].value) }));
  }, [m.series, m.latest]);
  const peakOf = (key: "pf" | "pv") => species.reduce((best, x) => (x[key] > best[key] ? x : best), species[0])?.label;

  return (
    <Section id="epi-time" title="Time · trend, season and outbreak detection" subtitle="How is transmission moving, when does it peak, and is anything unusual right now?">
      <ChartPanel
        title={`Epidemic curve — monthly confirmed cases, ${m.scopeLabel}`}
        note="Bars = reported cases per month; line = 12-month moving average (removes seasonality so the underlying trend shows). Drag the slider below the chart to zoom."
        height={340}
      >
        <ComposedChart data={curve} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" tick={axisTick} minTickGap={42} />
          <YAxis tick={axisTick} width={52} />
          <Tooltip formatter={tooltipValue} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="cases" name="Confirmed cases" fill={SERIES[0]} fillOpacity={0.55} isAnimationActive={false} />
          <Line dataKey="ma12" name="12-month moving average" stroke={SERIES[1]} strokeWidth={2.4} dot={false} connectNulls isAnimationActive={false} />
          <Brush dataKey="label" height={22} stroke={INK_MUTED} travellerWidth={8} />
        </ComposedChart>
      </ChartPanel>

      <div className="grid gap-4 lg:grid-cols-2">
        <PopoutCard
          title={`Endemic channel — ${m.scopeLabel}, ${m.endemic.year}`}
          downloadName={`endemic-channel-${m.scopeLabel}`}
          headerExtra={
            <p className="text-xs text-slate-500">
              Shaded = interquartile range of monthly cases in {m.endemic.baselineYears[0]}–{m.endemic.baselineYears[m.endemic.baselineYears.length - 1]} (WHO quartile method); red line = epidemic threshold (mean + 2 SD).
            </p>
          }
        >
          {(big) => (
            <>
              {!m.endemic.enough ? (
                <Note tone="warn">The endemic channel needs at least 3 earlier years of data — choose an earlier “From” year in the header.</Note>
              ) : aboveThreshold.length > 0 ? (
                <span className="mb-2 inline-block rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-800">⚠ Above epidemic threshold: {aboveThreshold.map((c) => c.label).join(", ")}</span>
              ) : (
                <span className="mb-2 inline-block rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">✓ No month above the epidemic threshold</span>
              )}
              <div className={big ? "h-[65vh]" : "h-72"}>
                <ChartInner>
                  <ComposedChart data={channel} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke={GRID} />
                    <XAxis dataKey="label" tick={axisTick} />
                    <YAxis tick={axisTick} width={48} />
                    <Tooltip formatter={tooltipValue} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area dataKey="band" name="Usual range (Q1–Q3)" stroke="none" fill={SERIES[0]} fillOpacity={0.15} isAnimationActive={false} />
                    <Line dataKey="median" name="Median" stroke="#898781" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    <Line dataKey="threshold" name="Epidemic threshold" stroke={STATUS.critical} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    <Line dataKey="previous" name={`${m.endemic.year - 1}`} stroke={SERIES[1]} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    <Line dataKey="current" name={`${m.endemic.year}`} stroke={SERIES[0]} strokeWidth={2.5} dot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} />
                  </ComposedChart>
                </ChartInner>
              </div>
            </>
          )}
        </PopoutCard>

        <ChartPanel
          title={`Cumulative cases year-to-date — ${m.endemic.year} vs earlier years`}
          note={
            <>
              The standard bulletin view: are we ahead of or behind last year and the {m.endemic.baselineYears.length}-year average?{" "}
              {ytdNow?.current != null && ytdNow.previous != null && (
                <>So far: <b>{fmtInt(ytdNow.current)}</b> cases — <Delta pct={pctChange(ytdNow.current, ytdNow.previous)} /> vs the same period in {m.endemic.year - 1}{ytdNow.baseline ? <>, <Delta pct={pctChange(ytdNow.current, ytdNow.baseline)} /> vs the average</> : null}.</>
              )}
            </>
          }
          height={300}
        >
          <LineChart data={cumulative} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tick={axisTick} />
            <YAxis tick={axisTick} width={52} />
            <Tooltip formatter={tooltipValue} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line dataKey="baseline" name={`${m.endemic.baselineYears.length}-yr average`} stroke="#898781" strokeWidth={1.8} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
            <Line dataKey="previous" name={`${m.endemic.year - 1}`} stroke={SERIES[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="current" name={`${m.endemic.year}`} stroke={SERIES[0]} strokeWidth={2.8} dot={{ r: 3, stroke: SURFACE, strokeWidth: 1 }} isAnimationActive={false} />
          </LineChart>
        </ChartPanel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartPanel
          title="Outbreak signal index — last 36 months"
          note={`Standardised excess over the same-season baseline (same month ±1 over the previous 5 years, spread floored at the Poisson SD). ≥ ${Z_WARN} = signal, ≥ ${Z_ALERT} = strong signal. Detects unusual months a fixed threshold can miss.`}
          height={300}
        >
          <BarChart data={signals} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tick={axisTick} minTickGap={34} />
            <YAxis tick={axisTick} width={40} domain={[(min: number) => Math.min(Math.floor(min), -1), (max: number) => Math.max(Math.ceil(max), Z_ALERT + 0.5)]} allowDataOverflow />
            <Tooltip
              formatter={(v, name) => (name === "z" || name === "Signal index" ? fmtNum(Number(v), 2) : tooltipValue(v))}
              labelFormatter={(l, items) => {
                const p = items?.[0]?.payload as { cases?: number; expected?: number } | undefined;
                return `${l} — ${fmtInt(p?.cases)} cases vs ~${fmtInt(p?.expected)} expected`;
              }}
            />
            <ReferenceLine y={Z_WARN} stroke={STATUS.warning} strokeDasharray="4 3" />
            <ReferenceLine y={Z_ALERT} stroke={STATUS.critical} strokeDasharray="4 3" />
            <ReferenceLine y={0} stroke="#898781" />
            <Bar dataKey="z" name="Signal index" isAnimationActive={false}>
              {signals.map((s) => (
                <Cell key={s.t} fill={s.z >= Z_ALERT ? STATUS.critical : s.z >= Z_WARN ? STATUS.warning : s.z < 0 ? "#9db9d8" : SERIES[0]} />
              ))}
            </Bar>
          </BarChart>
        </ChartPanel>

        <PopoutCard
          title={`Districts above seasonal expectation — ${m.latestLabel}`}
          headerExtra={<p className="text-xs text-slate-500">Latest month versus the district&apos;s own same-season baseline (≥ 5 cases and index ≥ {Z_WARN}).</p>}
        >
          {flagged.length === 0 ? (
            <p className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800">✓ No district is above its seasonal expectation this month.</p>
          ) : (
            <table className="min-w-full text-xs">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1 font-medium">District</th>
                  <th className="py-1 text-right font-medium">Cases</th>
                  <th className="py-1 text-right font-medium">Expected</th>
                  <th className="py-1 text-right font-medium">Excess</th>
                  <th className="py-1 text-right font-medium">Index</th>
                </tr>
              </thead>
              <tbody>
                {flagged.map((d) => (
                  <tr key={d.key} className="border-t border-slate-100 tabular-nums">
                    <td className="py-1.5"><span className="font-medium text-slate-800">{d.name}</span> <span className="text-slate-400">· {d.parent}</span></td>
                    <td className="py-1.5 text-right">{fmtInt(d.signal?.cases)}</td>
                    <td className="py-1.5 text-right text-slate-500">{fmtInt(d.signal?.expected)}</td>
                    <td className="py-1.5 text-right">+{fmtInt((d.signal?.cases ?? 0) - (d.signal?.expected ?? 0))}</td>
                    <td className="py-1.5 text-right">
                      <span className={`rounded px-1.5 py-0.5 font-semibold ${(d.signal?.z ?? 0) >= Z_ALERT ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900"}`}>{fmtNum(d.signal?.z, 1)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </PopoutCard>
      </div>

      <CalendarHeat m={m} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartPanel
          title="Seasonality — share of a year's cases by month"
          note={
            m.seasonal.peak
              ? `Average over ${m.seasonal.completeYears} complete years; the last 3 years overlaid to show whether the season is shifting. Peak window: ${m.seasonal.peak.from}–${m.seasonal.peak.to} (${fmtNum(m.seasonal.peak.share, 0)}% of cases).`
              : "Needs at least one complete calendar year of data."
          }
        >
          <ComposedChart data={m.seasonal.months} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tick={axisTick} />
            <YAxis tick={axisTick} width={44} tickFormatter={(v: number) => `${v}%`} />
            <Tooltip formatter={(v) => `${fmtNum(Number(v), 1)}%`} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="share" name="All complete years" fill={SERIES[0]} fillOpacity={0.6} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Line dataKey="recentShare" name="Last 3 years" stroke={SERIES[1]} strokeWidth={2.4} dot={{ r: 3, stroke: SURFACE, strokeWidth: 1 }} isAnimationActive={false} />
          </ComposedChart>
        </ChartPanel>

        <ChartPanel
          title="Species seasonality — typical month, last 5 complete years"
          note={`Mean cases per calendar month. P. falciparum peaks in ${peakOf("pf") ?? "—"}, P. vivax in ${peakOf("pv") ?? "—"}; differing seasons mean the two species need different timing for prevention and radical cure.`}
        >
          <LineChart data={species} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tick={axisTick} />
            <YAxis tick={axisTick} width={48} />
            <Tooltip formatter={tooltipValue} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line dataKey="pf" name="P. falciparum" stroke={SERIES[0]} strokeWidth={2.4} dot={{ r: 3, stroke: SURFACE, strokeWidth: 1 }} isAnimationActive={false} />
            <Line dataKey="pv" name="P. vivax" stroke={SERIES[1]} strokeWidth={2.4} dot={{ r: 3, stroke: SURFACE, strokeWidth: 1 }} isAnimationActive={false} />
          </LineChart>
        </ChartPanel>
      </div>

      <AnnualTable m={m} />
    </Section>
  );
}

/** Recharts needs its ResponsiveContainer inside an explicit-height box. */
function ChartInner({ children }: { children: React.ReactElement }) {
  return <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>;
}

/** Year × month heat table — the classic seasonal-pattern view; toggle between absolute and within-year colouring. */
function CalendarHeat({ m }: { m: EpiModel }) {
  const [scale, setScale] = useState<"all" | "year">("year");
  const grid = useMemo(() => {
    const byYear = new Map<number, (number | null)[]>();
    for (const p of m.series) {
      const row = byYear.get(p.year) ?? Array(12).fill(null);
      row[p.month - 1] = p.totals.cases;
      byYear.set(p.year, row);
    }
    return [...byYear].sort((a, b) => a[0] - b[0]);
  }, [m.series]);
  const globalMax = Math.max(1, ...grid.flatMap(([, r]) => r.map((v) => v ?? 0)));
  const monthLabels = m.endemic.months.map((c) => c.label);

  return (
    <PopoutCard
      title={`Calendar heat map — cases by month and year, ${m.scopeLabel}`}
      downloadName={`calendar-heatmap-${m.scopeLabel}`}
      headerExtra={<p className="text-xs text-slate-500">Each cell is that month&apos;s confirmed cases. “Within each year” shades every year against its own peak so the season stays visible even in low-burden years; “All years” shows relative burden.</p>}
      actions={
        <div className="flex overflow-hidden rounded-md border border-slate-200 text-[11px]" data-no-export="true">
          {(["year", "all"] as const).map((s) => (
            <button key={s} type="button" onClick={() => setScale(s)} className={`px-2 py-1 ${scale === s ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
              {s === "year" ? "Within each year" : "All years"}
            </button>
          ))}
        </div>
      }
    >
      <div className="overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-0.5 text-[11px] tabular-nums">
          <thead>
            <tr className="text-slate-500">
              <th className="px-1 text-left font-medium">Year</th>
              {monthLabels.map((l) => (
                <th key={l} className="px-1 text-center font-medium">{l}</th>
              ))}
              <th className="px-1 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {grid.map(([year, row]) => {
              const max = scale === "year" ? Math.max(1, ...row.map((v) => v ?? 0)) : globalMax;
              const total = row.reduce<number>((s, v) => s + (v ?? 0), 0);
              return (
                <tr key={year}>
                  <td className="px-1 font-medium text-slate-700">{year}</td>
                  {row.map((v, i) => (
                    <td
                      key={i}
                      title={v === null ? "No data" : `${monthLabels[i]} ${year}: ${fmtInt(v)} cases`}
                      style={v === null ? undefined : heatColor(Math.sqrt(v / max))}
                      className={`min-w-9 rounded px-1 py-1 text-center ${v === null ? "bg-slate-50 text-slate-300" : ""}`}
                    >
                      {v === null ? "·" : fmtInt(v)}
                    </td>
                  ))}
                  <td className="px-1 text-right font-semibold text-slate-800">{fmtInt(total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </PopoutCard>
  );
}

/** Annual surveillance summary — every headline indicator per year with year-on-year change. */
function AnnualTable({ m }: { m: EpiModel }) {
  const rows = m.yearly;
  return (
    <PopoutCard
      title={`Annual surveillance summary — ${m.scopeLabel}`}
      headerExtra={<p className="text-xs text-slate-500">API and ABER use population at risk from <b>{m.populationSource ?? "— (population workbook not imported)"}</b>; areas outside its 77 upazilas show “—”. Years with fewer than 12 reported months are marked.</p>}
    >
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="text-left text-slate-500">
            <tr>
              {["Year", "Cases", "YoY", "Tested", "TPR", "API", "ABER", "Pf+mixed", "Severe", "Deaths", "CFR"].map((h, i) => (
                <th key={h} className={`py-1 pr-3 font-medium ${i === 0 ? "" : "text-right"} ${h === "Deaths" ? "text-red-700" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((y, i) => {
              const t = y.totals;
              const prev = rows[i - 1]?.totals;
              return (
                <tr key={y.year} className="border-t border-slate-100 tabular-nums">
                  <td className="py-1.5 pr-3 font-medium text-slate-800">{y.year}{y.months < 12 && <span className="font-normal text-slate-400"> ({y.months} mo)</span>}</td>
                  <td className="py-1.5 pr-3 text-right">{fmtInt(t.cases)}</td>
                  <td className="py-1.5 pr-3 text-right">{prev && y.months === 12 ? <Delta pct={pctChange(t.cases, prev.cases)} /> : <span className="text-slate-300">—</span>}</td>
                  <td className="py-1.5 pr-3 text-right">{fmtInt(t.tests)}</td>
                  <td className="py-1.5 pr-3 text-right">{fmtNum(measureValue(t, "tpr"), 2)}%</td>
                  <td className="py-1.5 pr-3 text-right">{fmtNum(measureValue(t, "api"), 2)}</td>
                  <td className="py-1.5 pr-3 text-right">{measureValue(t, "aber") === null ? "—" : `${fmtNum(measureValue(t, "aber"), 0)}%`}</td>
                  <td className="py-1.5 pr-3 text-right">{fmtNum(measureValue(t, "pfShare"), 0)}%</td>
                  <td className="py-1.5 pr-3 text-right">{fmtInt(t.severe)}</td>
                  <td className={`py-1.5 pr-3 text-right ${t.deaths ? "font-semibold text-red-700" : ""}`}>{fmtInt(t.deaths)}</td>
                  <td className="py-1.5 text-right">{fmtNum(measureValue(t, "cfr"), 2)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </PopoutCard>
  );
}
