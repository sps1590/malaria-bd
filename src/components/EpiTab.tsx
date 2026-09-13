"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DownloadImageButton, Icon } from "@/components/ChartTools";
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
import { GRID, SERIES, STATUS, SURFACE, axisTick, fmtInt, fmtNum, tooltipValue } from "@/lib/chart-theme";
import {
  UNASSIGNED_DIVISION,
  decodeDataset,
  groupTotals,
  measureValue,
  percentOf,
  testPositivityRate,
  totalsOf,
  type MisDataset,
  type MisRecord,
} from "@/lib/malaria-metrics";

interface EndemicResponse {
  scope: string;
  year: number;
  latestMonth: number;
  baselineYears: number[];
  months: { month: number; label: string; q1: number; median: number; q3: number; threshold: number; current: number | null; previous: number }[];
}

export default function EpiTab({ dataset }: { dataset: MisDataset }) {
  const records = useMemo(() => decodeDataset(dataset), [dataset]);
  const [division, setDivision] = useState("");
  const [district, setDistrict] = useState("");
  const [endemic, setEndemic] = useState<EndemicResponse | null>(null);
  const channelRef = useRef<HTMLElement>(null);

  const divisions = useMemo(() => [...new Set(records.map((r) => r.divisionName))].filter((d) => d !== UNASSIGNED_DIVISION).sort(), [records]);
  const districts = useMemo(
    () => [...new Set(records.filter((r) => r.divisionName === division).map((r) => r.districtName))].sort(),
    [records, division],
  );
  const scoped = useMemo(
    () => records.filter((r) => (!division || r.divisionName === division) && (!district || r.districtName === district)),
    [records, division, district],
  );

  useEffect(() => {
    const qs = district ? `area=${encodeURIComponent(district)}&level=district` : division ? `area=${encodeURIComponent(division)}&level=division` : "level=national";
    let cancelled = false;
    fetch(`/api/insights/epi?${qs}`)
      .then((r) => r.json() as Promise<EndemicResponse>)
      .then((j) => !cancelled && setEndemic(j))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [division, district]);

  const years = useMemo(() => {
    return [...groupTotals(scoped, (r) => r.year)]
      .sort((a, b) => a[0] - b[0])
      .map(([year, t]) => ({
        year: String(year),
        pf: t.pf, pv: t.pv, mixed: t.mixed,
        active: t.acd, passive: t.pcd,
        severe_pct: percentOf(t.severe, t.cases),
        treated_pct: percentOf(t.treated, t.cases),
        referred_pct: percentOf(t.referred, t.cases),
        tpr: testPositivityRate(t.cases, t.tests),
        api: measureValue(t, "api"),
        aber: measureValue(t, "aber"),
        cases: t.cases, deaths: t.deaths,
      }));
  }, [scoped]);

  const totals = useMemo(() => totalsOf(scoped), [scoped]);
  const ages = [
    { group: "Under 1", cases: totals.ageLt1 },
    { group: "1–4", cases: totals.age1to4 },
    { group: "5–14", cases: totals.age5to14 },
    { group: "15+", cases: totals.age15plus },
  ];

  const completeness = useMemo(() => {
    const byMonth = new Map<string, Set<number>>();
    for (const r of scoped) {
      const key = `${r.year}-${String(r.month).padStart(2, "0")}`;
      let set = byMonth.get(key);
      if (!set) byMonth.set(key, (set = new Set()));
      set.add(r.upazilaId);
    }
    return [...byMonth].sort((a, b) => a[0].localeCompare(b[0])).map(([period, set]) => ({ period, units: set.size }));
  }, [scoped]);

  const hotspots = useMemo(() => {
    const latest = records.reduce((p, r) => Math.max(p, r.year * 12 + r.month - 1), 0);
    const units = new Map<number, { name: string; district: string; months: number; last12: number; prev12: number }>();
    for (const r of scoped) {
      const age = latest - (r.year * 12 + r.month - 1);
      if (age >= 24) continue;
      let u = units.get(r.upazilaId);
      if (!u) units.set(r.upazilaId, (u = { name: r.upazilaName, district: r.districtName, months: 0, last12: 0, prev12: 0 }));
      if (r.cases > 0) u.months++;
      if (age < 12) u.last12 += r.cases;
      else u.prev12 += r.cases;
    }
    return [...units.values()].filter((u) => u.months > 0).sort((a, b) => b.months - a.months || b.last12 - a.last12).slice(0, 12);
  }, [records, scoped]);

  const aboveThreshold = endemic?.months.filter((m) => m.current !== null && m.current > m.threshold) ?? [];
  const channel = endemic?.months.map((m) => ({ ...m, band: [m.q1, m.q3] })) ?? [];
  const scopeLabel = district || division || "Bangladesh";
  const period = years.length ? `${years[0].year}–${years[years.length - 1].year}` : "";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
        <select value={division} onChange={(e) => { setDivision(e.target.value); setDistrict(""); }} className="rounded border border-slate-300 px-2 py-1.5" aria-label="Division">
          <option value="">All divisions</option>
          {divisions.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={district} onChange={(e) => setDistrict(e.target.value)} disabled={!division} className="rounded border border-slate-300 px-2 py-1.5 disabled:opacity-50" aria-label="District">
          <option value="">{division ? "All districts" : "District…"}</option>
          {districts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <span className="text-xs text-slate-500">Panels below cover <b>{scopeLabel}</b>, {period} (year range from the header). The endemic channel always uses the latest 6 years.</span>
      </div>

      <section ref={channelRef} className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              Endemic channel — {endemic?.scope ?? scopeLabel}, {endemic?.year}
              <DownloadImageButton target={channelRef} filename={`endemic-channel-${scopeLabel}`} />
            </h3>
            <p className="text-xs text-slate-500">
              Shaded band = interquartile range of monthly cases in {endemic?.baselineYears[0]}–{endemic?.baselineYears[endemic.baselineYears.length - 1]} (WHO quartile method); red line = epidemic threshold (mean + 2 SD).
            </p>
          </div>
          {aboveThreshold.length > 0 ? (
            <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-800">
              ⚠ Above epidemic threshold: {aboveThreshold.map((m) => m.label).join(", ")}
            </span>
          ) : endemic ? (
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">✓ No month above the epidemic threshold</span>
          ) : null}
        </div>
        <div className="mt-3 h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={channel} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis dataKey="label" tick={axisTick} />
              <YAxis tick={axisTick} width={48} />
              <Tooltip formatter={tooltipValue} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area dataKey="band" name="Usual range (Q1–Q3)" stroke="none" fill={SERIES[0]} fillOpacity={0.15} isAnimationActive={false} />
              <Line dataKey="median" name="Median" stroke="#898781" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line dataKey="threshold" name="Epidemic threshold" stroke={STATUS.critical} strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line dataKey="previous" name={`${(endemic?.year ?? 0) - 1}`} stroke={SERIES[1]} strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line dataKey="current" name={`${endemic?.year ?? ""}`} stroke={SERIES[0]} strokeWidth={2.5} dot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Parasite species by year" note="P. falciparum causes most severe disease; mixed = both species.">
          <BarChart data={years} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="year" tick={axisTick} />
            <YAxis tick={axisTick} width={48} />
            <Tooltip formatter={tooltipValue} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="pf" name="P. falciparum" stackId="s" fill={SERIES[0]} stroke={SURFACE} strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="pv" name="P. vivax" stackId="s" fill={SERIES[1]} stroke={SURFACE} strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="mixed" name="Mixed" stackId="s" fill={SERIES[2]} stroke={SURFACE} strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </Panel>

        <Panel title="Case detection mode by year" note="Active case detection (ACD) = community/household screening; passive (PCD) = patients presenting at facilities.">
          <BarChart data={years} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="year" tick={axisTick} />
            <YAxis tick={axisTick} width={48} />
            <Tooltip formatter={tooltipValue} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="passive" name="Passive (PCD)" stackId="d" fill={SERIES[0]} stroke={SURFACE} strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="active" name="Active (ACD)" stackId="d" fill={SERIES[1]} stroke={SURFACE} strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </Panel>

        <Panel title={`Cases by age group — ${scopeLabel}, ${period}`}>
          <BarChart data={ages} layout="vertical" margin={{ top: 8, right: 24, bottom: 0, left: 8 }}>
            <CartesianGrid horizontal={false} stroke={GRID} />
            <XAxis type="number" tick={axisTick} />
            <YAxis type="category" dataKey="group" tick={axisTick} width={56} />
            <Tooltip formatter={tooltipValue} />
            <Bar dataKey="cases" name="Cases" fill={SERIES[0]} radius={[0, 4, 4, 0]} isAnimationActive={false} />
          </BarChart>
        </Panel>

        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-800">Who is affected & how cases are managed — {period}</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Male" value={`${fmtNum(percentOf(totals.male, totals.male + totals.female), 0)}%`} detail={`${fmtInt(totals.male)} cases`} />
            <Tile label="Female" value={`${fmtNum(percentOf(totals.female, totals.male + totals.female), 0)}%`} detail={`${fmtInt(totals.female)} cases`} />
            <Tile label="Pregnant women" value={fmtInt(totals.pregnant)} detail="cases" />
            <Tile danger label="Deaths" value={fmtInt(totals.deaths)} detail={`CFR ${fmtNum(percentOf(totals.deaths, totals.cases), 2)}%`} />
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="text-left text-slate-500">
                <tr><th className="py-1 font-medium">Year</th><th className="py-1 text-right font-medium">Cases</th><th className="py-1 text-right font-medium">API</th><th className="py-1 text-right font-medium">ABER</th><th className="py-1 text-right font-medium">TPR</th><th className="py-1 text-right font-medium">Severe</th><th className="py-1 text-right font-medium">Treated</th><th className="py-1 text-right font-medium">Referred</th><th className="py-1 text-right font-medium text-red-700">Deaths</th></tr>
              </thead>
              <tbody>
                {years.map((y) => (
                  <tr key={y.year} className="border-t border-slate-100 tabular-nums">
                    <td className="py-1">{y.year}</td>
                    <td className="py-1 text-right">{fmtInt(y.cases)}</td>
                    <td className="py-1 text-right">{fmtNum(y.api, 2)}</td>
                    <td className="py-1 text-right">{fmtNum(y.aber, 1)}%</td>
                    <td className="py-1 text-right">{fmtNum(y.tpr, 2)}%</td>
                    <td className="py-1 text-right">{fmtNum(y.severe_pct)}%</td>
                    <td className="py-1 text-right">{fmtNum(y.treated_pct)}%</td>
                    <td className="py-1 text-right">{fmtNum(y.referred_pct)}%</td>
                    <td className={`py-1 text-right ${y.deaths ? "font-semibold text-red-700" : ""}`}>{fmtInt(y.deaths)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-[11px] text-slate-500">
              API (per 1,000) and ABER (% tested) use population at risk from{" "}
              <b>{dataset.populationSource ?? "— (population workbook not imported)"}</b>; areas outside its 77 upazilas show “—”.
            </p>
          </div>
        </section>

        <Panel title="Reporting completeness" note="Reporting units (upazilas and facilities) that submitted a monthly MIS report — drops can signal missing data, not fewer cases.">
          <LineChart data={completeness} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="period" tick={axisTick} minTickGap={36} />
            <YAxis tick={axisTick} width={40} allowDecimals={false} />
            <Tooltip formatter={tooltipValue} />
            <Line dataKey="units" name="Reporting units" stroke={SERIES[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </Panel>

        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-800">Persistent hotspots — last 24 months</h3>
          <p className="text-xs text-slate-500">Reporting units ranked by the number of months with at least one case; trend compares the last 12 months with the 12 before.</p>
          <table className="mt-2 min-w-full text-xs">
            <thead className="text-left text-slate-500">
              <tr><th className="py-1 font-medium">Area</th><th className="py-1 text-right font-medium">Months with cases</th><th className="py-1 text-right font-medium">Last 12 mo</th><th className="py-1 text-right font-medium">Trend</th></tr>
            </thead>
            <tbody>
              {hotspots.map((h) => {
                const change = percentOf(h.last12 - h.prev12, h.prev12);
                return (
                  <tr key={`${h.district}-${h.name}`} className="border-t border-slate-100">
                    <td className="py-1"><span className="font-medium text-slate-800">{h.name}</span> <span className="text-slate-500">· {h.district}</span></td>
                    <td className="py-1 text-right tabular-nums">{h.months}/24</td>
                    <td className="py-1 text-right tabular-nums">{fmtInt(h.last12)}</td>
                    <td className={`py-1 text-right tabular-nums ${change !== null && change < 0 ? "text-emerald-700" : "text-rose-700"}`}>
                      {change === null ? "new" : `${change < 0 ? "▼" : "▲"} ${fmtNum(Math.abs(change), 0)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactElement }) {
  const ref = useRef<HTMLElement>(null);
  return (
    <section ref={ref} className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        <DownloadImageButton target={ref} filename={title} />
      </div>
      {note && <p className="text-xs text-slate-500">{note}</p>}
      <div className="mt-2 h-64">
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </section>
  );
}

function Tile({ label, value, detail, danger = false }: { label: string; value: string; detail: string; danger?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${danger ? "border-red-200 bg-red-50" : "border-slate-100 bg-slate-50"}`}>
      <div className={`flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide ${danger ? "text-red-700" : "text-slate-500"}`}>
        {danger && <Icon name="deaths" className="h-3.5 w-3.5" />}
        {label}
      </div>
      <div className={`text-xl font-bold ${danger ? "text-red-700" : "text-slate-900"}`}>{value}</div>
      <div className={`text-xs ${danger ? "text-red-700/80" : "text-slate-500"}`}>{detail}</div>
    </div>
  );
}

export type { MisRecord };
