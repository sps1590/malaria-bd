"use client";

import { Section } from "./EpiShared";
import type { EpiModel } from "./model";

const DEFS: [string, string][] = [
  ["API — annual parasite incidence", "Confirmed cases ÷ population-years × 1,000. Each reporting upazila-month contributes population ÷ 12 person-years, so API is valid for any slice of time or geography. Only upazilas with a population denominator (the 77 at-risk upazilas in the NSP workbook, plus their hospital units counted in the numerator) enter it."],
  ["TPR — test positivity rate", "Confirmed cases ÷ people tested × 100. Interpret with testing volume: low TPR with high testing = genuine low transmission; high TPR with low testing = under-detection."],
  ["ABER — annual blood examination rate", "People tested ÷ population-years × 100: how much of the population the surveillance system examines each year."],
  ["CFR — case-fatality ratio", "Deaths ÷ confirmed cases × 100. With very few deaths the ratio is unstable year to year; read it with the absolute count."],
  ["Endemic channel", "WHO quartile method: for each calendar month, the interquartile range of the same month over the previous 5 years; a month above mean + 2 SD of those years exceeds the epidemic threshold."],
  ["Outbreak signal index", "A same-season aberration index in the spirit of CDC EARS: (observed − baseline mean) ÷ spread, where the baseline is the same month ±1 over the previous 5 years and the spread is floored at the Poisson SD √mean. ≥ 2 flags a signal, ≥ 3 a strong signal. Area signals additionally require ≥ 5 cases to avoid noise in very small counts."],
  ["Seasonal index", "The average share of a complete year's cases that falls in each calendar month; the peak window is the strongest consecutive three months."],
  ["Concentration (Lorenz / Gini)", "Areas are ranked by cases; the Lorenz curve shows the cumulative share of cases against the cumulative share of areas. Gini 0 = perfectly even, 1 = all cases in one area."],
  ["API strata", "Analyst-defined classes of upazila-year incidence: no cases; very low (< 1 per 1,000); low (1 – < 10); moderate (10 – < 50); high (≥ 50). They are for tracking movement and are not an official NMEP classification."],
  ["Elimination status", "Active = a case in the last 12 months; cleared = cases 12–36 months ago but none since; historic only = last case over 3 years ago. The MIS feed does not separate local from imported cases, so this is a reported-case proxy, not a WHO elimination certification."],
];

export default function EpiMethods({ m }: { m: EpiModel }) {
  return (
    <Section id="epi-methods" title="Methods, definitions & data notes" subtitle="So every number can be audited.">
      <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm open:shadow-sm">
        <summary className="cursor-pointer text-sm font-semibold text-slate-800">Indicator definitions and method notes</summary>
        <dl className="mt-3 grid gap-x-6 gap-y-3 lg:grid-cols-2">
          {DEFS.map(([term, text]) => (
            <div key={term}>
              <dt className="text-xs font-semibold text-slate-800">{term}</dt>
              <dd className="text-xs leading-relaxed text-slate-600">{text}</dd>
            </div>
          ))}
        </dl>
      </details>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs leading-relaxed text-slate-600">
        <p className="mb-1 font-semibold text-slate-700">Data notes</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Source: NMEP/NMCP LMIS monthly reports (upazila × month), {m.firstYear}–{m.lastYear}; the newest month is <b>{m.latestLabel}</b>. All figures are reported confirmed cases (RDT/microscopy), not modelled burden.</li>
          <li>The number of reporting units grew in 2018 when hospital and facility units were added; counts before and after are not strictly like-for-like, so use rates (API, TPR) for cross-year comparison.</li>
          <li>The case-detection split (active vs passive) is recorded from 2021, referral is reported unevenly, and treatment is recorded for almost every case — read those fields as reporting practice as much as clinical fact.</li>
          <li>API and ABER use population at risk from <b>{m.populationSource ?? "— (population workbook not imported)"}</b>.</li>
          <li>The panels cover the geography chosen in the scope bar; the endemic channel and signal detection need several earlier years, so choose an early “From” year in the header (default: full history).</li>
        </ul>
      </div>
    </Section>
  );
}
