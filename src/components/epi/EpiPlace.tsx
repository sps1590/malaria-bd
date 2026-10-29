"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BUILT_BY, PopoutCard } from "@/components/ChartTools";
import { GRID, SERIES, SURFACE, axisTick, fmtInt, fmtNum, tooltipValue } from "@/lib/chart-theme";
import { STRATA, concentration, pctChange, periodLabel, strataByYear, stratumOf, type AreaRow } from "@/lib/epi-calc";
import { measureValue, percentOf } from "@/lib/malaria-metrics";
import { ChartPanel, Delta, Section, Sparkline } from "./EpiShared";
import type { EpiModel } from "./model";

type SortKey = "name" | "cases" | "change" | "api" | "tpr" | "aber" | "pf" | "deaths" | "months" | "signal" | "silent";

const rowStats = (r: AreaRow) => ({
  cases: r.last12.cases,
  change: pctChange(r.last12.cases, r.prev12.cases),
  api: measureValue(r.last12, "api"),
  tpr: measureValue(r.last12, "tpr"),
  aber: measureValue(r.last12, "aber"),
  pf: measureValue(r.last12, "pfShare"),
  deaths: r.last12.deaths,
  months: r.monthsWithCases24,
  signal: r.signal?.z ?? null,
  silent: r.zeroStreak,
});

export default function EpiPlace({ m, level }: { m: EpiModel; level: "district" | "upazila" }) {
  return (
    <Section id="epi-place" title="Place · where is the burden, and where is it ending?" subtitle="Geographic targeting, risk strata and progress towards elimination.">
      <LeagueTable m={m} level={level} />
      <div className="grid gap-4 lg:grid-cols-2">
        <TopUpazilas m={m} />
        <Lorenz m={m} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Strata m={m} />
        <Elimination m={m} level={level} />
      </div>
    </Section>
  );
}

/* ------------------------------ League table ------------------------------ */

function LeagueTable({ m, level }: { m: EpiModel; level: "district" | "upazila" }) {
  const rowsAll = level === "district" ? m.districtRows : m.upazilaRows;
  const [sortKey, setSortKey] = useState<SortKey>("cases");
  const [dir, setDir] = useState<1 | -1>(-1);
  const [onlyActive, setOnlyActive] = useState(true);
  const [limit, setLimit] = useState(15);

  const total = m.last12.cases;
  const rows = useMemo(() => {
    const val = (r: AreaRow): number | string | null => (sortKey === "name" ? r.name : rowStats(r)[sortKey]);
    return rowsAll
      .filter((r) => !onlyActive || r.last12.cases > 0 || r.prev12.cases > 0)
      .sort((a, b) => {
        const x = val(a);
        const y = val(b);
        if (x === null && y === null) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        return typeof x === "string" ? dir * x.localeCompare(String(y)) : dir * (x - Number(y)) || b.last12.cases - a.last12.cases;
      });
  }, [rowsAll, sortKey, dir, onlyActive]);
  const shown = rows.slice(0, limit);
  const maxCases = Math.max(1, ...shown.map((r) => r.last12.cases));

  const head = (key: SortKey, label: string, title: string, align = "text-right") => (
    <th className={`py-1.5 pr-3 font-medium ${align}`}>
      <button type="button" title={title} onClick={() => (key === sortKey ? setDir((d) => (d === 1 ? -1 : 1)) : (setSortKey(key), setDir(key === "name" ? 1 : -1)))} className="hover:text-indigo-700">
        {label}
        {sortKey === key ? (dir === -1 ? " ▼" : " ▲") : ""}
      </button>
    </th>
  );

  function downloadCsv() {
    const header = ["Area", "Parent", "Cases 12m", "Cases prev 12m", "Change %", "API", "TPR %", "ABER %", "Pf+mixed %", "Deaths 12m", "Months with cases (24)", "Months since last case", "Signal index"];
    const body = rows.map((r) => {
      const s = rowStats(r);
      return [r.name, r.parent, s.cases, r.prev12.cases, s.change === null ? "" : s.change.toFixed(1), s.api?.toFixed(2) ?? "", s.tpr?.toFixed(2) ?? "", s.aber?.toFixed(1) ?? "", s.pf?.toFixed(1) ?? "", s.deaths, s.months, s.silent ?? "", s.signal?.toFixed(2) ?? ""];
    });
    const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [header, ...body, [], [BUILT_BY]].map((r) => r.map(esc).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
    a.download = `malaria-${level}-league-${m.scopeLabel}.csv`.replace(/[^\w.-]+/g, "-").toLowerCase();
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <PopoutCard
      title={`${level === "district" ? "District" : "Upazila"} league table — last 12 months, ${m.scopeLabel}`}
      downloadName={`${level}-league-${m.scopeLabel}`}
      headerExtra={<p className="text-xs text-slate-500">Ranked by confirmed cases ({m.last12Label}) with trend against the previous 12 months, indicators, persistence, outbreak signal and elimination status. Click a column to re-rank.</p>}
      actions={
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600" data-no-export="true">
          <label className="flex cursor-pointer items-center gap-1">
            <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> Hide areas with no cases in 24 mo
          </label>
          <button type="button" onClick={downloadCsv} className="rounded-md border border-slate-200 px-2 py-1 hover:border-indigo-300 hover:text-indigo-700">CSV</button>
        </div>
      }
    >
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="text-left text-slate-500">
            <tr>
              {head("name", level === "district" ? "District" : "Upazila", "Sort by name", "text-left")}
              {head("cases", "Cases", "Confirmed cases, last 12 months")}
              <th className="py-1.5 pr-3 text-left font-medium">Share</th>
              {head("change", "vs prev 12", "Change versus the 12 months before")}
              {head("api", "API", "Cases per 1,000 population at risk per year")}
              {head("tpr", "TPR", "Test positivity rate")}
              {head("aber", "ABER", "Annual blood examination rate")}
              {head("pf", "Pf+mixed", "Share of cases with P. falciparum (alone or mixed)")}
              {head("deaths", "Deaths", "Deaths, last 12 months")}
              {head("months", "Active months", "Months with ≥ 1 case in the last 24 (persistence)")}
              <th className="py-1.5 pr-3 text-left font-medium">24-mo trend</th>
              {head("signal", "Signal", "Latest-month outbreak signal index (≥ 2 = above expectation)")}
              {head("silent", "Status", "Months since the last case")}
              <th className="py-1.5 text-left font-medium">Stratum</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const s = rowStats(r);
              const st = stratumOf(s.api, s.cases);
              return (
                <tr key={r.key} className="border-t border-slate-100 tabular-nums">
                  <td className="py-1.5 pr-3 text-left"><span className="font-medium text-slate-800">{r.name}</span> <span className="text-slate-400">· {r.parent}</span></td>
                  <td className="py-1.5 pr-3 text-right font-semibold">{fmtInt(s.cases)}</td>
                  <td className="py-1.5 pr-3">
                    <div className="flex items-center gap-1.5">
                      <div className="h-2 w-16 overflow-hidden rounded bg-slate-100"><div className="h-full rounded" style={{ width: `${(s.cases / maxCases) * 100}%`, background: SERIES[0] }} /></div>
                      <span className="w-9 text-right text-slate-500">{total ? `${fmtNum((s.cases / total) * 100, 1)}%` : "—"}</span>
                    </div>
                  </td>
                  <td className="py-1.5 pr-3 text-right"><Delta pct={s.change} /></td>
                  <td className="py-1.5 pr-3 text-right">{fmtNum(s.api, 2)}</td>
                  <td className="py-1.5 pr-3 text-right" title={r.last12.tests < 50 ? `Only ${r.last12.tests} tests — rate is unreliable` : undefined}>
                    {s.tpr === null ? "—" : <span className={r.last12.tests < 50 ? "text-slate-400" : ""}>{fmtNum(s.tpr, 2)}%{r.last12.tests < 50 ? "*" : ""}</span>}
                  </td>
                  <td className="py-1.5 pr-3 text-right">{s.aber === null ? "—" : `${fmtNum(s.aber, 0)}%`}</td>
                  <td className="py-1.5 pr-3 text-right">{s.pf === null ? "—" : `${fmtNum(s.pf, 0)}%`}</td>
                  <td className={`py-1.5 pr-3 text-right ${s.deaths ? "font-semibold text-red-700" : "text-slate-400"}`}>{s.deaths || "—"}</td>
                  <td className="py-1.5 pr-3 text-right">{s.months}/24</td>
                  <td className="py-1.5 pr-3"><Sparkline values={r.spark} width={84} height={22} /></td>
                  <td className="py-1.5 pr-3 text-right">
                    {s.signal === null ? <span className="text-slate-300">—</span> : (
                      <span className={`rounded px-1.5 py-0.5 ${s.signal >= 3 && r.signal!.cases >= 5 ? "bg-red-100 font-semibold text-red-800" : s.signal >= 2 && r.signal!.cases >= 5 ? "bg-amber-100 font-semibold text-amber-900" : "text-slate-500"}`}>{fmtNum(s.signal, 1)}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-[11px]">
                    {s.silent === null ? <span className="text-slate-300">no cases</span> : s.silent === 0 ? <span className="font-medium text-rose-700">cases now</span> : s.silent >= 12 ? <span className="font-medium text-emerald-700">{s.silent} mo silent</span> : <span className="text-slate-500">{s.silent} mo ago</span>}
                  </td>
                  <td className="py-1.5 text-left">
                    {st === null ? <span className="text-slate-300">—</span> : (
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <span className="inline-block h-2.5 w-2.5 rounded-sm border border-slate-300" style={{ background: STRATA[st].color }} />
                        {STRATA[st].label.split(" (")[0]}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
        <span>Showing {shown.length} of {rows.length} {level === "district" ? "districts" : "upazilas"}. Strata are by API (cases per 1,000 at risk); “—” = no population denominator; * = fewer than 50 tests, so the rate is unreliable.</span>
        {rows.length > limit && (
          <button type="button" onClick={() => setLimit((l) => (l >= rows.length ? 15 : rows.length))} className="rounded border border-slate-200 px-2 py-1 text-slate-700 hover:border-indigo-300" data-no-export="true">
            {limit >= rows.length ? "Show top 15" : `Show all ${rows.length}`}
          </button>
        )}
      </div>
    </PopoutCard>
  );
}

/* ------------------------------ Concentration ----------------------------- */

function TopUpazilas({ m }: { m: EpiModel }) {
  const top = useMemo(() => {
    const total = m.last12.cases;
    const sorted = [...m.reportingUpazilas].sort((a, b) => b.last12.cases - a.last12.cases).slice(0, 15);
    const out: { name: string; cases: number; cumulative: number }[] = [];
    let run = 0;
    for (const u of sorted) {
      run += u.last12.cases;
      out.push({ name: `${u.name} · ${u.parent}`, cases: u.last12.cases, cumulative: total ? Math.round((run / total) * 100) : 0 });
    }
    return out;
  }, [m]);
  return (
    <ChartPanel
      title="Highest-burden upazilas — last 12 months"
      note="The cumulative share is in the tooltip: how much of the national/scope burden the top areas explain together."
      height={430}
    >
      <BarChart data={top} layout="vertical" margin={{ top: 8, right: 24, bottom: 0, left: 8 }}>
        <CartesianGrid horizontal={false} stroke={GRID} />
        <XAxis type="number" tick={axisTick} />
        <YAxis type="category" dataKey="name" tick={axisTick} width={170} interval={0} tickFormatter={(v: string) => (v.length > 28 ? `${v.slice(0, 27)}…` : v)} />
        <Tooltip formatter={(v, _n, item) => [`${fmtInt(Number(v))} cases (cumulative ${(item?.payload as { cumulative?: number })?.cumulative ?? 0}% of total)`, "Cases"]} />
        <Bar dataKey="cases" name="Cases" fill={SERIES[0]} radius={[0, 4, 4, 0]} isAnimationActive={false} />
      </BarChart>
    </ChartPanel>
  );
}

function Lorenz({ m }: { m: EpiModel }) {
  const { curve, conc } = useMemo(() => {
    const vals = m.reportingUpazilas.map((u) => u.last12.cases).sort((a, b) => a - b);
    const total = vals.reduce((s, v) => s + v, 0);
    const n = vals.length;
    const curve = [{ pop: 0, cases: 0, equal: 0 }];
    let run = 0;
    vals.forEach((v, i) => {
      run += v;
      const pop = Math.round(((i + 1) / n) * 1000) / 10;
      curve.push({ pop, cases: total ? Math.round((run / total) * 1000) / 10 : 0, equal: pop });
    });
    return { curve, conc: concentration(vals) };
  }, [m]);
  return (
    <ChartPanel
      title="Concentration of cases (Lorenz curve)"
      note={`The further the curve bows below the diagonal, the more unevenly cases are spread. Gini = ${fmtNum(conc.gini, 2)}; ${conc.n80} of ${conc.areas} reporting upazilas account for 80% of cases — focus resources there.`}
      height={430}
    >
      <LineChart data={curve} margin={{ top: 8, right: 16, bottom: 20, left: 0 }}>
        <CartesianGrid stroke={GRID} />
        <XAxis dataKey="pop" type="number" domain={[0, 100]} tick={axisTick} tickFormatter={(v: number) => `${v}%`} label={{ value: "Cumulative share of upazilas (lowest → highest burden)", position: "insideBottom", offset: -10, fontSize: 11, fill: "#898781" }} />
        <YAxis domain={[0, 100]} tick={axisTick} width={44} tickFormatter={(v: number) => `${v}%`} />
        <Tooltip formatter={(v) => `${v}%`} labelFormatter={(l) => `Lowest ${l}% of upazilas`} />
        <Legend wrapperStyle={{ fontSize: 12 }} verticalAlign="top" />
        <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]} stroke="#898781" strokeDasharray="5 4" />
        <Line dataKey="cases" name="Share of cases" stroke={SERIES[1]} strokeWidth={2.6} dot={false} isAnimationActive={false} />
      </LineChart>
    </ChartPanel>
  );
}

/* --------------------------------- Strata --------------------------------- */

function Strata({ m }: { m: EpiModel }) {
  const data = useMemo(() => strataByYear(m.scoped).map((y) => ({ year: String(y.year), ...Object.fromEntries(STRATA.map((s, i) => [s.key, y.counts[i]])) })), [m.scoped]);
  return (
    <ChartPanel
      title="Risk stratification over time — upazilas by API class"
      note="Population-covered upazilas grouped by annual parasite incidence (cases per 1,000 at risk). Movement towards the lighter classes shows transmission being pushed back; analyst-defined cut-offs."
      height={330}
    >
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="year" tick={axisTick} />
        <YAxis tick={axisTick} width={40} allowDecimals={false} />
        <Tooltip formatter={tooltipValue} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {STRATA.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId="s" fill={s.color} stroke={SURFACE} strokeWidth={1} radius={i === STRATA.length - 1 ? [3, 3, 0, 0] : 0} isAnimationActive={false} />
        ))}
      </BarChart>
    </ChartPanel>
  );
}

/* ------------------------------- Elimination ------------------------------ */

function Elimination({ m, level }: { m: EpiModel; level: "district" | "upazila" }) {
  const ups = m.reportingUpazilas;
  const buckets = useMemo(() => {
    const active = ups.filter((u) => u.last12.cases > 0).length;
    const cleared = ups.filter((u) => u.last12.cases === 0 && u.prev12.cases + u.earlier12Cases > 0).length;
    const historic = ups.filter((u) => u.last12.cases === 0 && u.prev12.cases + u.earlier12Cases === 0 && u.allTimeCases > 0).length;
    const never = ups.length - active - cleared - historic;
    return [
      { label: "Active", detail: "cases in the last 12 months", n: active, color: "#e4502f" },
      { label: "Cleared", detail: "cases 12–36 months ago, none since", n: cleared, color: "#fbbf5a" },
      { label: "Historic only", detail: "last case over 3 years ago", n: historic, color: "#9db9d8" },
      { label: "Never a case", detail: "no case in the loaded data", n: never, color: "#d6d4cc" },
    ];
  }, [ups]);

  const perYear = useMemo(() => {
    const act = new Map<number, Set<number>>();
    const rep = new Map<number, Set<number>>();
    for (const r of m.scoped) {
      (rep.get(r.year) ?? rep.set(r.year, new Set()).get(r.year)!).add(r.upazilaId);
      if (r.cases > 0) (act.get(r.year) ?? act.set(r.year, new Set()).get(r.year)!).add(r.upazilaId);
    }
    return [...rep].sort((a, b) => a[0] - b[0]).map(([year, set]) => ({ year: String(year), reporting: set.size, active: act.get(year)?.size ?? 0 }));
  }, [m.scoped]);

  const closest = useMemo(() => {
    const rows = level === "district" ? m.districtRows : m.upazilaRows;
    return rows
      .filter((r) => r.zeroStreak !== null && r.zeroStreak >= 1 && r.prev12.cases + r.earlier12Cases + r.last12.cases > 0)
      .sort((a, b) => (b.zeroStreak ?? 0) - (a.zeroStreak ?? 0) || b.prev12.cases + b.earlier12Cases - (a.prev12.cases + a.earlier12Cases))
      .slice(0, 8);
  }, [m, level]);
  const sum = buckets.reduce((s, b) => s + b.n, 0) || 1;

  return (
    <PopoutCard
      title="Elimination progress — status of reporting upazilas"
      headerExtra={<p className="text-xs text-slate-500">Where has transmission been interrupted? Areas that stay silent for 12+ months are candidates for elimination verification and surveillance-only status.</p>}
    >
      <div className="mb-3 flex h-5 w-full overflow-hidden rounded-md border border-slate-200" role="img" aria-label="Upazila status breakdown">
        {buckets.map((b) => (
          <div key={b.label} title={`${b.label}: ${b.n}`} style={{ width: `${(b.n / sum) * 100}%`, background: b.color }} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {buckets.map((b) => (
          <div key={b.label} className="rounded-lg border border-slate-100 bg-slate-50 p-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: b.color }} />{b.label}</div>
            <div className="text-lg font-bold tabular-nums text-slate-900">{fmtInt(b.n)}</div>
            <div className="text-[10px] leading-tight text-slate-500">{b.detail}</div>
          </div>
        ))}
      </div>

      <h4 className="mb-1 mt-4 text-xs font-semibold text-slate-700">Upazilas reporting vs upazilas with cases, by year</h4>
      <div className="h-44">
        <MiniLines data={perYear} />
      </div>

      <h4 className="mb-1 mt-3 text-xs font-semibold text-slate-700">Longest silent {level === "district" ? "districts" : "upazilas"} (had cases before)</h4>
      {closest.length === 0 ? (
        <p className="text-xs text-slate-500">Every area with a case history reported a case recently.</p>
      ) : (
        <table className="min-w-full text-xs">
          <thead className="text-left text-slate-500">
            <tr><th className="py-1 font-medium">Area</th><th className="py-1 text-right font-medium">Months silent</th><th className="py-1 text-right font-medium">Last case</th><th className="py-1 text-right font-medium">Cases before that (3 y)</th></tr>
          </thead>
          <tbody>
            {closest.map((r) => (
              <tr key={r.key} className="border-t border-slate-100 tabular-nums">
                <td className="py-1"><span className="font-medium text-slate-800">{r.name}</span> <span className="text-slate-400">· {r.parent}</span></td>
                <td className="py-1 text-right font-semibold text-emerald-700">{r.zeroStreak}</td>
                <td className="py-1 text-right text-slate-500">{periodLabel(m.latest - (r.zeroStreak ?? 0))}</td>
                <td className="py-1 text-right">{fmtInt(r.prev12.cases + r.earlier12Cases + r.last12.cases)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-[11px] text-slate-500">
        Status uses reported confirmed cases only — the MIS feed does not separate local from imported cases, so “silent” means no case of any origin; {percentOf(buckets[0].n, sum) !== null && `${fmtNum(percentOf(buckets[0].n, sum), 0)}% of reporting upazilas are currently active.`}
      </p>
    </PopoutCard>
  );
}

function MiniLines({ data }: { data: { year: string; reporting: number; active: number }[] }) {
  return (
    <ChartPanelless>
      <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="year" tick={axisTick} />
        <YAxis tick={axisTick} width={36} allowDecimals={false} />
        <Tooltip formatter={tooltipValue} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line dataKey="reporting" name="Reporting upazilas" stroke="#898781" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line dataKey="active" name="With ≥ 1 case" stroke={SERIES[1]} strokeWidth={2.4} dot={{ r: 3, stroke: SURFACE, strokeWidth: 1 }} isAnimationActive={false} />
      </LineChart>
    </ChartPanelless>
  );
}

function ChartPanelless({ children }: { children: React.ReactElement }) {
  return <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>;
}
