"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import { PopoutCard } from "@/components/ChartTools";
import { GRID, SERIES, STATUS, SURFACE, axisTick, fmtInt, fmtNum, tooltipValue } from "@/lib/chart-theme";
import { quantile } from "@/lib/epi-calc";
import { measureValue, percentOf, type Totals } from "@/lib/malaria-metrics";
import { ChartPanel, Note, Section } from "./EpiShared";
import type { EpiModel } from "./model";

const round2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

/** Case-management cascade, severity/mortality and the surveillance-quality indicators behind them. */
export default function EpiClinical({ m }: { m: EpiModel }) {
  const periodTotals = useMemo(() => {
    const t = m.yearly.reduce<Totals | null>((acc, y) => {
      if (!acc) return { ...y.totals };
      for (const k of Object.keys(acc) as (keyof Totals)[]) acc[k] += y.totals[k];
      return acc;
    }, null);
    return t;
  }, [m.yearly]);

  const yearly = useMemo(
    () =>
      m.yearly.map((y) => ({
        year: String(y.year),
        severePct: round2(percentOf(y.totals.severe, y.totals.cases)),
        deaths: y.totals.deaths,
        cfr: round2(percentOf(y.totals.deaths, y.totals.cases)),
        deathsPerSevere: round2(percentOf(y.totals.deaths, y.totals.severe)),
        tests: y.totals.tests,
        tpr: round2(measureValue(y.totals, "tpr")),
        aber: round2(measureValue(y.totals, "aber")),
        acd: y.totals.acd,
        pcd: y.totals.pcd,
        llin: y.totals.llin + y.totals.llinc,
      })),
    [m.yearly],
  );
  const detection = yearly.filter((y) => y.acd + y.pcd > 0);
  const llin = yearly.filter((y) => y.llin > 0);

  const completeness = useMemo(() => {
    const byMonth = new Map<number, Set<number>>();
    for (const r of m.scoped) {
      const t = r.year * 12 + r.month - 1;
      (byMonth.get(t) ?? byMonth.set(t, new Set()).get(t)!).add(r.upazilaId);
    }
    return [...byMonth].sort((a, b) => a[0] - b[0]).map(([t, set]) => ({ period: `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`, units: set.size }));
  }, [m.scoped]);

  const scatter = useMemo(() => {
    const pts = m.upazilaRows
      .map((u) => ({ name: `${u.name} · ${u.parent}`, aber: measureValue(u.last12, "aber"), tpr: measureValue(u.last12, "tpr"), cases: u.last12.cases, tests: u.last12.tests }))
      .filter((p): p is { name: string; aber: number; tpr: number; cases: number; tests: number } => p.aber !== null && p.tpr !== null && p.cases > 0 && p.tests >= 50)
      .map((p) => ({ ...p, aber: Math.round(p.aber * 10) / 10, tpr: Math.round(p.tpr * 100) / 100 }));
    const med = (k: "aber" | "tpr") => quantile(pts.map((p) => p[k]).sort((a, b) => a - b), 0.5);
    return { pts, medAber: med("aber"), medTpr: med("tpr") };
  }, [m.upazilaRows]);

  return (
    <>
      <Section id="epi-clinical" title="Clinical · case management and outcomes" subtitle="From diagnosis to treatment, severity and death.">
        <div className="grid gap-4 lg:grid-cols-2">
          <Cascade m={m} periodTotals={periodTotals} />
          <div className="grid gap-4">
            <ChartPanel title="Severe malaria — share of confirmed cases" note="Severe disease signals late presentation or delayed treatment; the aim is to keep it as low as possible." height={170}>
              <LineChart data={yearly} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="year" tick={axisTick} />
                <YAxis tick={axisTick} width={44} tickFormatter={(v: number) => `${v}%`} />
                <Tooltip formatter={(v) => `${v}%`} />
                <Line dataKey="severePct" name="Severe share" stroke={SERIES[1]} strokeWidth={2.4} dot={{ r: 3, stroke: SURFACE, strokeWidth: 1 }} isAnimationActive={false} />
              </LineChart>
            </ChartPanel>
            <ChartPanel
              title="Deaths by year"
              note="Tooltip: case-fatality (deaths per 100 confirmed cases) and deaths per 100 severe cases."
              height={170}
            >
              <BarChart data={yearly} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="year" tick={axisTick} />
                <YAxis tick={axisTick} width={36} allowDecimals={false} />
                <Tooltip
                  formatter={(v, _n, item) => {
                    const p = item?.payload as { cfr?: number | null; deathsPerSevere?: number | null };
                    return [`${v} (CFR ${fmtNum(p.cfr, 2)}% · ${fmtNum(p.deathsPerSevere, 1)} per 100 severe)`, "Deaths"];
                  }}
                />
                <Bar dataKey="deaths" name="Deaths" fill={STATUS.critical} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ChartPanel>
          </div>
        </div>
      </Section>

      <Section id="epi-surveillance" title="Surveillance & programme quality" subtitle="Is the system finding the cases? Testing effort, reporting completeness, detection strategy and vector control.">
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartPanel title="Testing effort — people tested per year" note="More testing with falling positivity is the signature of a programme closing in on elimination." height={260}>
            <BarChart data={yearly} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis dataKey="year" tick={axisTick} />
              <YAxis tick={axisTick} width={52} tickFormatter={(v: number) => (v >= 1_000_000 ? `${fmtNum(v / 1_000_000, 1)}M` : `${Math.round(v / 1000)}k`)} />
              <Tooltip formatter={tooltipValue} />
              <Bar dataKey="tests" name="People tested" fill={SERIES[2]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ChartPanel>
          <ChartPanel title="Test positivity rate (TPR) by year" note="Confirmed cases ÷ people tested. Sustained decline alongside stable or rising testing indicates a real fall in transmission, not a reporting artefact." height={260}>
            <LineChart data={yearly} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis dataKey="year" tick={axisTick} />
              <YAxis tick={axisTick} width={44} tickFormatter={(v: number) => `${v}%`} />
              <Tooltip formatter={(v) => `${v}%`} />
              <Line dataKey="tpr" name="TPR" stroke={SERIES[1]} strokeWidth={2.4} dot={{ r: 3, stroke: SURFACE, strokeWidth: 1 }} isAnimationActive={false} />
            </LineChart>
          </ChartPanel>

          <ChartPanel
            title={`Testing adequacy — ABER vs TPR by upazila, ${m.last12Label}`}
            note="Each dot is an at-risk upazila with cases and at least 50 tests (size = cases). Top-left = few people tested but many positive (possible under-testing / missed cases); bottom-right = broad testing with low positivity. Lines mark the medians."
            height={340}
          >
            <ScatterChart margin={{ top: 12, right: 20, bottom: 24, left: 4 }}>
              <CartesianGrid stroke={GRID} />
              <XAxis type="number" dataKey="aber" name="ABER" tick={axisTick} tickFormatter={(v: number) => `${v}%`} label={{ value: "ABER — % of population tested per year", position: "insideBottom", offset: -12, fontSize: 11, fill: "#898781" }} />
              <YAxis type="number" dataKey="tpr" name="TPR" tick={axisTick} width={44} tickFormatter={(v: number) => `${v}%`} />
              <ZAxis type="number" dataKey="cases" range={[50, 520]} name="Cases" />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                content={({ payload }) => {
                  const p = payload?.[0]?.payload as { name: string; aber: number; tpr: number; cases: number } | undefined;
                  return p ? (
                    <div className="rounded border border-slate-200 bg-white px-2 py-1 text-xs shadow">
                      <b>{p.name}</b>
                      <div>ABER {fmtNum(p.aber, 1)}% · TPR {fmtNum(p.tpr, 2)}%</div>
                      <div>{fmtInt(p.cases)} cases</div>
                    </div>
                  ) : null;
                }}
              />
              <ReferenceLine x={scatter.medAber} stroke="#898781" strokeDasharray="4 3" />
              <ReferenceLine y={scatter.medTpr} stroke="#898781" strokeDasharray="4 3" />
              <Scatter data={scatter.pts} fill={SERIES[0]} fillOpacity={0.6} stroke={SURFACE} isAnimationActive={false} />
            </ScatterChart>
          </ChartPanel>

          <ChartPanel
            title="Reporting completeness — units reporting each month"
            note="Upazilas and facilities that submitted a monthly MIS report. Step changes (e.g. when hospital units joined in 2018) change coverage, so read case trends across them with care; dips can mean missing data, not fewer cases."
            height={340}
          >
            <LineChart data={completeness} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis dataKey="period" tick={axisTick} minTickGap={36} />
              <YAxis tick={axisTick} width={40} allowDecimals={false} />
              <Tooltip formatter={tooltipValue} />
              <Line dataKey="units" name="Reporting units" stroke={SERIES[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ChartPanel>

          <ChartPanel
            title="Case detection strategy — active vs passive"
            note="Active (ACD) = community/household screening; passive (PCD) = patients attending facilities. The MIS began recording the split in 2021, so earlier years are omitted rather than shown as zero."
            height={280}
          >
            {detection.length ? (
              <BarChart data={detection} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="year" tick={axisTick} />
                <YAxis tick={axisTick} width={48} />
                <Tooltip formatter={tooltipValue} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="pcd" name="Passive (PCD)" stackId="d" fill={SERIES[0]} stroke={SURFACE} strokeWidth={1} isAnimationActive={false} />
                <Bar dataKey="acd" name="Active (ACD)" stackId="d" fill={SERIES[1]} stroke={SURFACE} strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            ) : (
              <BarChart data={[]} />
            )}
          </ChartPanel>

          <ChartPanel
            title="Vector control — LLINs reported distributed per year"
            note="Long-lasting insecticidal nets recorded in the MIS (LLIN + LLIN-C). Distribution is campaign-driven, so bars are lumpy; compare with the case curve for impact over the following seasons."
            height={280}
          >
            {llin.length ? (
              <BarChart data={llin} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="year" tick={axisTick} />
                <YAxis tick={axisTick} width={52} tickFormatter={(v: number) => (v >= 1_000_000 ? `${fmtNum(v / 1_000_000, 1)}M` : `${Math.round(v / 1000)}k`)} />
                <Tooltip formatter={tooltipValue} />
                <Bar dataKey="llin" name="LLINs distributed" fill={SERIES[5]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            ) : (
              <BarChart data={[]} />
            )}
          </ChartPanel>
        </div>
      </Section>
    </>
  );
}

/* --------------------------------- Cascade -------------------------------- */

function Cascade({ m, periodTotals }: { m: EpiModel; periodTotals: Totals | null }) {
  const cols = [
    { label: `Last 12 months`, sub: m.last12Label, t: m.last12 },
    { label: "Whole selected period", sub: `${m.firstYear}–${m.lastYear}`, t: periodTotals },
  ];
  const stages: { label: string; note: string; get: (t: Totals) => number; color: string; danger?: boolean }[] = [
    { label: "Confirmed cases", note: "Parasitologically confirmed (RDT / microscopy)", get: (t) => t.cases, color: SERIES[0] },
    { label: "Treated", note: "Received anti-malarial treatment", get: (t) => t.treated, color: SERIES[2] },
    { label: "Uncomplicated", note: "Outpatient-manageable", get: (t) => t.uncomplicated, color: "#8dbbea" },
    { label: "Severe malaria", note: "Needs hospital care", get: (t) => t.severe, color: SERIES[1] },
    { label: "Referred", note: "Referred to higher-level facility", get: (t) => t.referred, color: SERIES[3] },
    { label: "Deaths", note: "Malaria deaths reported", get: (t) => t.deaths, color: STATUS.critical, danger: true },
  ];
  return (
    <PopoutCard
      title="Case-management cascade"
      headerExtra={<p className="text-xs text-slate-500">Every stage as a share of confirmed cases — where do patients drop out of the continuum of care?</p>}
    >
      <div className="space-y-3">
        {cols.map((c) =>
          c.t ? (
            <div key={c.label}>
              <div className="mb-1 flex items-baseline justify-between">
                <h4 className="text-xs font-semibold text-slate-700">{c.label}</h4>
                <span className="text-[11px] text-slate-400">{c.sub}</span>
              </div>
              <div className="space-y-1">
                {stages.map((s) => {
                  const v = s.get(c.t as Totals);
                  const pct = percentOf(v, (c.t as Totals).cases);
                  return (
                    <div key={s.label} className="grid grid-cols-[104px_1fr_auto] items-center gap-2 text-xs" title={s.note}>
                      <span className={s.danger ? "font-medium text-red-700" : "text-slate-600"}>{s.label}</span>
                      <div className="h-3.5 overflow-hidden rounded bg-slate-100">
                        <div className="h-full rounded" style={{ width: `${Math.max(pct === null ? 0 : Math.min(pct, 100), v > 0 ? 0.6 : 0)}%`, background: s.color }} />
                      </div>
                      <span className="w-32 text-right tabular-nums text-slate-700">
                        <b>{fmtInt(v)}</b> <span className="text-slate-400">{pct === null ? "" : `· ${fmtNum(pct, pct < 10 ? 2 : 1)}%`}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null,
        )}
      </div>
      <Note>
        Treatment is recorded for almost every confirmed case, so near-100% reflects the MIS recording practice. Referral is reported inconsistently across years — treat it as a lower bound. Deaths per 100 severe cases: <b>{fmtNum(percentOf(m.last12.deaths, m.last12.severe), 1)}</b> (last 12 months).
      </Note>
    </PopoutCard>
  );
}
