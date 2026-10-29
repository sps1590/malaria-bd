"use client";

import { useMemo, type ReactNode } from "react";
import { fmtInt, fmtNum } from "@/lib/chart-theme";
import { concentration, pctChange, windowTotals } from "@/lib/epi-calc";
import { measureValue, percentOf } from "@/lib/malaria-metrics";
import { Delta, Kpi } from "./EpiShared";
import type { EpiModel } from "./model";

type Tone = "good" | "bad" | "info";
interface Insight {
  tone: Tone;
  icon: string;
  text: ReactNode;
}

const TONE_STYLE: Record<Tone, string> = {
  good: "border-l-emerald-500 bg-emerald-50/60",
  bad: "border-l-rose-500 bg-rose-50/60",
  info: "border-l-indigo-400 bg-indigo-50/50",
};

const B = ({ children }: { children: ReactNode }) => <b className="font-semibold text-slate-900">{children}</b>;
const list = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** Executive summary: KPI strip plus auto-written key findings an epidemiologist would lead a bulletin with. */
export default function EpiSummary({ m }: { m: EpiModel }) {
  const { last12: a, prev12: p } = m;
  const k = useMemo(() => {
    const cases = a.cases;
    const casesChg = pctChange(cases, p.cases);
    const monthlyCases = m.series.slice(-24).map((s) => s.totals.cases);
    const monthlyDeaths = m.series.slice(-24).map((s) => s.totals.deaths);
    const monthlyTests = m.series.slice(-24).map((s) => s.totals.tests);
    const monthlyTpr = m.series.slice(-24).map((s) => percentOf(s.totals.cases, s.totals.tests) ?? 0);
    const api = measureValue(a, "api");
    const apiPrev = measureValue(p, "api");
    const tpr = measureValue(a, "tpr");
    const tprPrev = measureValue(p, "tpr");
    const aber = measureValue(a, "aber");
    const pfShare = measureValue(a, "pfShare");
    const active = m.reportingUpazilas.filter((u) => u.last12.cases > 0).length;
    const reporting = m.reportingUpazilas.length;
    const cleared = m.reportingUpazilas.filter((u) => u.last12.cases === 0 && u.prev12.cases + u.earlier12Cases > 0).length;
    const silentDistricts = m.districtRows.filter((d) => d.zeroStreak !== null && d.zeroStreak >= 12 && d.allTimeCases > 0);
    const conc = concentration(m.reportingUpazilas.map((u) => u.last12.cases));
    const topDistricts = [...m.districtRows].sort((x, y) => y.last12.cases - x.last12.cases).filter((d) => d.last12.cases > 0);
    const top3 = topDistricts.slice(0, 3);
    const top3Share = percentOf(top3.reduce((s, d) => s + d.last12.cases, 0), cases);
    const signals = m.districtRows.filter((d) => d.signal && d.signal.z >= 2 && d.signal.cases >= 5).sort((x, y) => (y.signal?.z ?? 0) - (x.signal?.z ?? 0));
    const threeYearsAgo = windowTotals(m.scoped, m.latest, 36, 48);
    const pvNow = percentOf(a.pv, cases);
    const pvThen = percentOf(threeYearsAgo.pv, threeYearsAgo.cases);
    const deathsTop = [...m.districtRows].sort((x, y) => y.last12.deaths - x.last12.deaths).filter((d) => d.last12.deaths > 0).slice(0, 2);
    return { cases, casesChg, monthlyCases, monthlyDeaths, monthlyTests, monthlyTpr, api, apiPrev, tpr, tprPrev, aber, pfShare, active, reporting, cleared, silentDistricts, conc, top3, top3Share, signals, pvNow, pvThen, threeYearsAgo, deathsTop };
  }, [m, a, p]);

  const insights = useMemo<Insight[]>(() => {
    const out: Insight[] = [];
    if (k.casesChg !== null) {
      out.push({
        tone: k.casesChg <= 0 ? "good" : "bad",
        icon: k.casesChg <= 0 ? "▼" : "▲",
        text: (
          <>
            <B>{fmtInt(k.cases)} confirmed cases</B> in {m.scopeLabel} over the last 12 months ({m.last12Label}) — <B>{fmtNum(Math.abs(k.casesChg), 1)}% {k.casesChg <= 0 ? "lower" : "higher"}</B> than the {fmtInt(p.cases)} of the 12 months before.
            {k.api !== null && <> Incidence is <B>{fmtNum(k.api, 2)} per 1,000</B> population at risk.</>}
          </>
        ),
      });
    }
    if (k.top3.length && k.top3Share !== null) {
      out.push({
        tone: "info",
        icon: "◎",
        text: (
          <>
            Burden is concentrated: <B>{list(k.top3.map((d) => d.name))}</B> hold <B>{fmtNum(k.top3Share, 0)}%</B> of cases
            {k.conc.areas > 0 && k.conc.n80 > 0 && <>, and just <B>{k.conc.n80} of {k.conc.areas} reporting upazilas</B> account for 80% (Gini {fmtNum(k.conc.gini, 2)}) — a strong case for sub-district targeting.</>}
          </>
        ),
      });
    }
    if (k.signals.length) {
      out.push({
        tone: "bad",
        icon: "⚠",
        text: (
          <>
            <B>{k.signals.length} district{k.signals.length > 1 ? "s" : ""} above the seasonal expectation</B> in {m.latestLabel}: {list(k.signals.slice(0, 3).map((d) => `${d.name} (${d.signal?.cases} vs ~${Math.round(d.signal?.expected ?? 0)} expected)`))}. Review the signal panel below.
          </>
        ),
      });
    } else {
      out.push({ tone: "good", icon: "✓", text: <>No district exceeded its same-season expectation by 2 SD in {m.latestLabel}.</> });
    }
    if (m.seasonal.peak) {
      out.push({
        tone: "info",
        icon: "◐",
        text: (
          <>
            Transmission is seasonal: <B>{m.seasonal.peak.from}–{m.seasonal.peak.to}</B> carries about <B>{fmtNum(m.seasonal.peak.share, 0)}%</B> of a typical year&apos;s cases ({m.seasonal.completeYears} complete years) — time vector-control and case-management surge before this window.
          </>
        ),
      });
    }
    if (k.pvNow !== null && k.pvThen !== null && Math.abs(k.pvNow - k.pvThen) >= 3) {
      out.push({
        tone: k.pvNow > k.pvThen ? "bad" : "good",
        icon: "◍",
        text: (
          <>
            Species mix is shifting: <i>P. vivax</i> is now <B>{fmtNum(k.pvNow, 0)}%</B> of cases versus {fmtNum(k.pvThen, 0)}% three years earlier
            {k.pvNow > k.pvThen ? " — relapse-aware (radical-cure) case management matters more as vivax gains share." : "."} <i>P. falciparum</i> + mixed is {fmtNum(k.pfShare, 0)}%.
          </>
        ),
      });
    }
    if (k.reporting > 0) {
      out.push({
        tone: k.cleared > 0 ? "good" : "info",
        icon: "◇",
        text: (
          <>
            <B>{k.active} of {k.reporting}</B> reporting upazilas had at least one case in the last 12 months; <B>{k.cleared}</B> that had cases earlier in the data recorded none (cleared foci)
            {k.silentDistricts.length > 0 && <>, and {k.silentDistricts.length} district{k.silentDistricts.length > 1 ? "s have" : " has"} been silent for 12+ months ({list(k.silentDistricts.slice(0, 3).map((d) => d.name))}{k.silentDistricts.length > 3 ? "…" : ""})</>}.
          </>
        ),
      });
    }
    if (a.deaths > 0 || p.deaths > 0) {
      out.push({
        tone: a.deaths <= p.deaths ? "good" : "bad",
        icon: "✚",
        text: (
          <>
            <B>{a.deaths} malaria death{a.deaths === 1 ? "" : "s"}</B> in the last 12 months (previous 12: {p.deaths}); case-fatality <B>{fmtNum(percentOf(a.deaths, a.cases), 2)}%</B>
            {k.deathsTop.length > 0 && <>, reported mainly in {list(k.deathsTop.map((d) => `${d.name} (${d.last12.deaths})`))}</>}.
            {a.severe > 0 && <> Severe malaria is {fmtNum(percentOf(a.severe, a.cases), 1)}% of cases.</>}
          </>
        ),
      });
    }
    const testsChg = pctChange(a.tests, p.tests);
    if (testsChg !== null) {
      out.push({
        tone: "info",
        icon: "⚗",
        text: (
          <>
            Surveillance effort: <B>{fmtInt(a.tests)}</B> people tested ({testsChg >= 0 ? "+" : "−"}{fmtNum(Math.abs(testsChg), 0)}% vs the prior 12 months), test positivity <B>{fmtNum(k.tpr, 2)}%</B>
            {k.tprPrev !== null && k.tpr !== null && <> (was {fmtNum(k.tprPrev, 2)}%)</>}. Very low positivity with high testing is the hallmark of a programme moving towards elimination.
          </>
        ),
      });
    }
    return out;
  }, [k, m, a, p]);

  const spark12 = (v: number[]) => v;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Confirmed cases" value={fmtInt(a.cases)} delta={<Delta pct={k.casesChg} />} sub="vs prior 12 mo" spark={spark12(k.monthlyCases)} title={`Last 12 months: ${m.last12Label}`} />
        <Kpi label="Deaths" value={fmtInt(a.deaths)} tone="danger" delta={<Delta pct={pctChange(a.deaths, p.deaths)} />} sub={`CFR ${fmtNum(percentOf(a.deaths, a.cases), 2)}%`} spark={k.monthlyDeaths} />
        <Kpi label="API per 1,000" value={fmtNum(k.api, 2)} delta={<Delta pct={k.api !== null && k.apiPrev !== null ? pctChange(k.api, k.apiPrev) : null} />} sub="at-risk pop." title="Annual Parasite Incidence — confirmed cases per 1,000 population at risk per year" />
        <Kpi label="Test positivity" value={`${fmtNum(k.tpr, 2)}%`} delta={<Delta pct={k.tpr !== null && k.tprPrev !== null ? pctChange(k.tpr, k.tprPrev) : null} />} sub="of tested" spark={k.monthlyTpr} sparkColor="#eb6834" />
        <Kpi label="People tested" value={fmtInt(a.tests)} delta={<Delta pct={pctChange(a.tests, p.tests)} goodWhenDown={false} />} sub={k.aber !== null ? `ABER ${fmtNum(k.aber, 0)}%` : undefined} spark={k.monthlyTests} sparkColor="#1baf7a" title="Number of persons examined by RDT or microscopy" />
        <Kpi label="Pf + mixed share" value={`${fmtNum(k.pfShare, 0)}%`} sub="of cases" title="Share of cases with P. falciparum (alone or mixed) — the species behind severe disease" />
        <Kpi label="Active upazilas" value={fmtInt(k.active)} sub={`of ${fmtInt(k.reporting)} reporting`} title="Upazilas with at least one confirmed case in the last 12 months" />
        <Kpi label="Severe malaria" value={`${fmtNum(percentOf(a.severe, a.cases), 1)}%`} sub={`${fmtInt(a.severe)} cases`} title="Severe cases as a share of confirmed cases" />
      </div>

      <div className="rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-white p-4">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-indigo-950">
          <span aria-hidden className="text-cyan-600">✦</span> Key findings — {m.scopeLabel}, {m.last12Label}
        </h3>
        <ul className="grid gap-2 lg:grid-cols-2">
          {insights.map((x, i) => (
            <li key={i} className={`flex gap-2 rounded-lg border-l-4 p-2.5 text-[13px] leading-snug text-slate-700 ${TONE_STYLE[x.tone]}`}>
              <span aria-hidden className="mt-0.5 w-4 shrink-0 text-center text-slate-500">{x.icon}</span>
              <span>{x.text}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-slate-500">Findings are generated from the loaded MIS data and update with the scope selector; they describe reported confirmed cases, not estimated burden.</p>
      </div>
    </div>
  );
}
