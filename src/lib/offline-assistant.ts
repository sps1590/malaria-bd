/**
 * Rule-based assistant used when no ANTHROPIC_API_KEY is configured.
 * Understands common questions (cases/deaths/tests/TPR by area and period, rankings,
 * forecasts, weather, climate links, alerts) and answers from the same queries the AI agent uses.
 */
import {
  climateCorrelation,
  dataOverview,
  getAreaIndex,
  getForecast,
  getWeather,
  malariaStats,
  recentAlerts,
  resolveArea,
  type AreaIndex,
  type Level,
} from "@/lib/agent-data";
import { MONTHS, canonicalGeoName } from "@/lib/malaria-metrics";
import { nspComparison } from "@/lib/nsp";

const n = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

function findArea(index: AreaIndex, question: string) {
  const q = question.toLowerCase();
  const level: Level | undefined = /\bupazila|upazilla|thana\b/.test(q) ? "upazila" : /\bdistrict|zila\b/.test(q) ? "district" : /\bdivision\b/.test(q) ? "division" : undefined;
  const words = q.replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter(Boolean);
  // Longest word windows first so "cox's bazar" beats "bazar".
  const phrases: string[] = [];
  for (let size = 3; size >= 1; size--) {
    for (let i = 0; i + size <= words.length; i++) {
      const phrase = words.slice(i, i + size).join(" ");
      if (canonicalGeoName(phrase).length >= 4) phrases.push(phrase);
    }
  }
  const first = (resolve: (phrase: string) => ReturnType<typeof resolveArea>) => {
    for (const phrase of phrases) {
      const area = resolve(phrase);
      if (area) return area;
    }
    return null;
  };
  // Exact division/district/upazila names beat loose (consonant-skeleton) upazila matches, which
  // otherwise catch ordinary word runs such as "is the api".
  const exactUpazila = (phrase: string) =>
    index.upazilas.some((u) => canonicalGeoName(u.name) === canonicalGeoName(phrase)) ? resolveArea(index, phrase, "upazila") : null;
  // The loose (consonant-skeleton) upazila match is only tried when the question explicitly says
  // "upazila"/"thana" — otherwise ordinary words ("trend", "since", "is the api") sound-alike their
  // way to a real upazila name and hijack an unrelated question.
  return (
    (level ? first((p) => (level === "upazila" ? exactUpazila(p) : resolveArea(index, p, level))) : null) ??
    first((p) => resolveArea(index, p, "division") ?? resolveArea(index, p, "district")) ??
    first(exactUpazila) ??
    (level === "upazila" ? first((p) => resolveArea(index, p, "upazila")) : null)
  );
}

/** For "compare X and Y" / "X vs Y" questions: resolve up to two distinct areas, one per side of the split. */
function findAreas(index: AreaIndex, question: string): ReturnType<typeof findArea>[] {
  const parts = question.split(/\bversus\b|\bvs\.?\b|\band\b|,/i).map((p) => p.trim()).filter(Boolean);
  const found: NonNullable<ReturnType<typeof findArea>>[] = [];
  for (const part of parts) {
    const area = findArea(index, part);
    if (area && !found.some((a) => a.label === area.label)) found.push(area);
  }
  return found;
}

function findYears(question: string, lastYear: number): { from?: number; to?: number } {
  const q = question.toLowerCase();
  const years = [...question.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1])).sort();
  if (years.length) {
    // "since/from/after 2012" (no end year) or "...to date/now/present" means through the latest data,
    // not a single-year slice — the assistant otherwise misreads "2012 to date" as just 2012.
    const openEnded = years.length === 1 && (/\b(since|from|after)\b/.test(q) || /\b(to date|till date|to now|until now|to present|so far)\b/.test(q));
    return { from: years[0], to: openEnded ? lastYear : years[years.length - 1] };
  }
  if (/\b(all time|all-time|entire history|since inception|historical(ly)?|full history|since the beginning)\b/.test(q)) {
    return { from: 2000, to: lastYear };
  }
  if (/this year|current year/.test(q)) return { from: lastYear, to: lastYear };
  if (/last year|previous year/.test(q)) return { from: lastYear - 1, to: lastYear - 1 };
  const span = q.match(/last (\d+) years/);
  if (span) return { from: lastYear - Number(span[1]) + 1, to: lastYear };
  return {};
}

function findMonths(question: string): number[] | undefined {
  const q = question.toLowerCase();
  const months = MONTHS.map((m, i) => (new RegExp(`\\b${m.toLowerCase()}|\\b${m.slice(0, 3).toLowerCase()}\\b`).test(q) ? i + 1 : 0)).filter(Boolean);
  return months.length ? months : undefined;
}

const FOOTER = "\n\nOffline assistant (rule-based). Add an `ANTHROPIC_API_KEY` to enable the full AI analyst for free-form questions.";

export async function answerOffline(question: string): Promise<string> {
  const q = question.toLowerCase();
  const overview = await dataOverview();
  const lastYear = Number(overview.data_years.split("–")[1]);
  const index = await getAreaIndex();
  const area = findArea(index, question);
  const { from, to } = findYears(question, lastYear);
  const months = findMonths(question);
  const scopeName = area?.label ?? "Bangladesh";

  if (/\bcompar(e|ing|ison)\b|\bversus\b|\bvs\.?\b/.test(q)) {
    const areas = findAreas(index, question);
    if (areas.length >= 2) {
      const period = to ?? lastYear;
      const rows = await Promise.all(
        areas.slice(0, 2).map((a) =>
          malariaStats({
            area: a!.district ?? a!.division,
            level: a!.level === "upazila" ? undefined : a!.level,
            yearFrom: from ?? period,
            yearTo: period,
            months,
          }),
        ),
      );
      const lines = rows.map((r, i) => {
        if ("error" in r) return `- **${areas[i]!.label}**: ${r.error}`;
        const row = r.rows[0];
        return row
          ? `- **${areas[i]!.label}**: ${n(row.cases)} cases, ${n(row.deaths)} deaths, ${n(row.tests)} tested, TPR ${n(row.tpr_pct, 2)}%`
          : `- **${areas[i]!.label}**: no reports for ${r.period}`;
      });
      return `**Comparison — ${from && from !== period ? `${from}–${period}` : period}**\n${lines.join("\n")}${FOOTER}`;
    }
  }

  if (/forecast|predict|projection|next month|next year|future|expect/.test(q)) {
    const target = /death/.test(q) ? "deaths" : "cases";
    const f = await getForecast({ area: area && area.level !== "upazila" ? (area.district ?? area.division) : undefined, target });
    const points = f.available && "forecast" in f ? f.forecast : undefined;
    if (!points) return `${"note" in f ? f.note : "No forecast available."}${FOOTER}`;
    const run = ("run" in f ? f.run : null) as Record<string, unknown> | null;
    const lines = points.slice(0, 6).map((p) => `- **${MONTHS[Number(p.month) - 1]} ${p.year}**: ~${n(Number(p.predicted))} ${target} (80% range ${n(Number(p.lo80))}–${n(Number(p.hi80))})`);
    return `**${target === "deaths" ? "Death" : "Case"} forecast — ${scopeName}**\n${lines.join("\n")}\n\nModel: **${run?.model ?? "—"}** — ${run?.notes ?? ""}${FOOTER}`;
  }

  if (!area && /(last|past) (12 months|year)|changed|how has malaria|situation/.test(q)) {
    const w = overview.last_12_months;
    const change = w.change_pct === null ? "—" : `${w.change_pct > 0 ? "+" : ""}${n(w.change_pct, 1)}%`;
    const top = (overview.top_districts_last_12_months as unknown as { district_name: string; cases: number; deaths: number }[])
      .slice(0, 5)
      .map((d) => `${d.district_name} ${n(Number(d.cases))}`)
      .join(", ");
    return `**Bangladesh — last 12 months to ${overview.latest_data_month}**
- Confirmed cases: **${n(w.confirmed_cases)}** (${change} vs the previous 12 months: ${n(w.previous_12_months_cases)})
- Deaths: **${n(w.deaths)}**
- Tested: **${n(w.tests)}** — test positivity **${n(w.tpr_pct, 2)}%**
- Upazilas with cases: **${n(w.upazilas_with_cases)}**
- Highest-burden districts: ${top}${FOOTER}`;
  }

  if (/population|nsp|strategic plan|target|\bapi\b|annual parasite|aber|blood examination/.test(q)) {
    const district = area?.level === "district" ? area.district : undefined;
    const nsp = await nspComparison({ district });
    if (!nsp.available) return `${nsp.note}${FOOTER}`;
    const year = to ?? lastYear;
    const row = nsp.years.find((y) => y.year === year) ?? nsp.years[nsp.years.length - 1];
    const pct = (v: number | null) => (v === null ? "—" : `${n(v, 1)}%`);
    return `**Population, API/ABER and NSP targets — ${nsp.scope}, ${row.year}**
- Population at risk: **${n(row.population)}**
- Confirmed cases: **${n(row.actual_cases)}**${row.months_reported < 12 ? ` (${row.months_reported} months reported)` : ""} · NSP target **${n(row.nsp_cases)}** · expected (actual + forecast) **${n(row.expected_cases)}**
- API: **${n(row.api_actual, 2)}** per 1,000 · NSP target ${n(row.nsp_api, 2)}
- ABER: **${pct(row.aber_actual_pct)}** · NSP target ${pct(row.nsp_aber_pct)}
- Tests: ${n(row.actual_tests)} · NSP target ${n(row.nsp_tests)}
- Deaths: ${n(row.actual_deaths)} · NSP target ${n(row.nsp_deaths, 1)}

Source file: \`${nsp.source}\` (BBS Census 2022 projected; NSP intensified scenario).${FOOTER}`;
  }

  if (/alert|surge|spike|outbreak|sudden/.test(q)) {
    const { alerts } = await recentAlerts({ limit: 10 });
    if (!alerts.length) return `No death or surge alerts have been recorded yet.${FOOTER}`;
    const lines = alerts.map((a) =>
      a.kind === "death"
        ? `- **${a.observed} death(s)** — ${a.upazila_name ?? a.district_name}, ${a.district_name} (${MONTHS[Number(a.report_month) - 1]} ${a.report_year})`
        : `- **Surge** — ${a.upazila_name ?? a.district_name} ${a.level}: ${n(Number(a.observed))} cases vs usual ~${n(Number(a.expected))} (${MONTHS[Number(a.report_month) - 1]} ${a.report_year})`,
    );
    return `**Most recent alerts**\n${lines.join("\n")}${FOOTER}`;
  }

  if (/correlat|relationship|influence|impact|affect|link/.test(q) && /rain|weather|temperat|humid|climate/.test(q)) {
    const c = await climateCorrelation({ area: area?.district ?? area?.division });
    if (!("strongest" in c) || !c.strongest) {
      return `${"note" in c ? c.note : "error" in c ? c.error : "Climate analysis unavailable."}${FOOTER}`;
    }
    const s = c.strongest;
    return `**Climate and malaria — ${c.scope} (${c.period})**\nStrongest association: **${s?.variable.replace(/_/g, " ")}** ${s?.lag_months} month(s) earlier (Spearman ρ = **${s?.spearman_rho}**, ${s?.months} months).\n${c.method}${FOOTER}`;
  }

  if (/weather|rain|temperat|humid|dew|climate|soil/.test(q)) {
    const w = await getWeather({ area: area?.district ?? area?.division, yearFrom: from ?? lastYear, yearTo: to ?? lastYear, groupBy: "year" });
    const weatherRows = w.available && "rows" in w ? w.rows : undefined;
    if (!weatherRows) return `${"note" in w ? w.note : "Weather unavailable."}${FOOTER}`;
    const lines = weatherRows.map((r) => ("year" in r ? `- **${r.year}**: mean ${r.temp_mean_c} °C, rainfall ${n(r.rainfall_mm_total)} mm, humidity ${r.humidity_pct}% (${r.months} months)` : ""));
    return `**ERA5 weather — ${"scope" in w ? w.scope : ""}**\n${lines.join("\n")}${FOOTER}`;
  }

  const ranking = /which|top|highest|most|rank|worst|hotspot|lowest|least/.test(q);
  const rankMetric = /death/.test(q) ? "deaths" : /tpr|positiv/.test(q) ? "tpr_pct" : "cases";
  const trend = /trend|monthly|each month|by month|over time/.test(q);
  const total = /\btotal\b|\boverall\b|\baltogether\b|\bcombined\b|\bcumulative\b|\bin all\b|\ball[- ]?time\b/.test(q);
  const byYear = !total && /each year|by year|yearly|annual|per year|compare/.test(q);
  const stats = await malariaStats({
    area: area ? (area.level === "upazila" ? question.match(new RegExp(area.label.split(" ")[0], "i"))?.[0] ?? area.label : area.district ?? area.division) : undefined,
    level: area?.level,
    yearFrom: from ?? (ranking || trend ? lastYear : lastYear),
    yearTo: to ?? lastYear,
    months,
    // "total"/"overall" sums the whole range into one row even when it spans several years.
    // "yearly"/"annual" (byYear) wins over a bare "trend" — "yearly trend" means grouped by year, not by month.
    groupBy: ranking ? "area" : byYear ? "year" : trend ? "month" : total ? "none" : (from !== undefined && to !== undefined && from !== to) ? "year" : "none",
    rankLevel: /upazila/.test(q) ? "upazila" : /district/.test(q) ? "district" : /division/.test(q) ? "division" : undefined,
    sortBy: rankMetric,
    top: 10,
  });
  if ("error" in stats) return `${stats.error}${FOOTER}`;

  if (ranking) {
    const metric = rankMetric;
    const rows = [...stats.rows].sort((a, b) => Number(b[metric] ?? -1) - Number(a[metric] ?? -1)).slice(0, 10);
    const lines = rows.map((r, i) => `${i + 1}. **${r.group}** — ${n(r.cases)} cases, ${n(r.deaths)} deaths, TPR ${n(r.tpr_pct, 2)}%`);
    return `**Areas ranked by ${metric === "tpr_pct" ? "test positivity" : metric} — ${stats.scope}, ${stats.period}**\n${lines.join("\n")}${FOOTER}`;
  }
  if (stats.rows.length > 1) {
    const lines = stats.rows.map((r) => `- **${r.group}**: ${n(r.cases)} cases, ${n(r.deaths)} deaths, ${n(r.tests)} tested, TPR ${n(r.tpr_pct, 2)}%`);
    return `**${stats.scope} — ${stats.period}**\n${lines.join("\n")}${FOOTER}`;
  }
  const r = stats.rows[0];
  if (!r) return `No malaria reports were found for ${stats.scope} in ${stats.period}.${FOOTER}`;
  return `**${stats.scope} — ${stats.period}** (data up to ${stats.latest_data_month})\n- Confirmed cases: **${n(r.cases)}** (P. falciparum ${n(r.pf)}, P. vivax ${n(r.pv)}, mixed ${n(r.mixed)}; Pf+mixed share ${n(r.pf_share_pct, 1)}%)\n- Deaths: **${n(r.deaths)}** (case fatality ${n(r.cfr_pct, 3)}%)\n- Tested: **${n(r.tests)}** — test positivity **${n(r.tpr_pct, 2)}%**\n- Severe: ${n(r.severe)} · Treated: ${n(r.treated_pct, 1)}% · Pregnant women: ${n(r.pregnant)}\n- Age: <1 ${n(r.age_under1)}, 1–4 ${n(r.age_1_4)}, 5–14 ${n(r.age_5_14)}, 15+ ${n(r.age_15_plus)} · Male ${n(r.male)}, female ${n(r.female)}${FOOTER}`;
}
