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

interface Period {
  year: number;
  month: number; // 1–12
}
const periodLabel = (p: Period) => `${MONTHS[p.month - 1]} ${p.year}`;
const shiftMonth = (p: Period, delta: number): Period => {
  const t = p.year * 12 + (p.month - 1) + delta;
  return { year: Math.floor(t / 12), month: (t % 12) + 1 };
};
/** "August 2026" -> {year: 2026, month: 8}, from dataOverview()'s latest_data_month string. */
function parseLatestPeriod(label: string): Period | null {
  const m = /^([A-Za-z]+)\s+(\d{4})$/.exec(label.trim());
  const month = m ? MONTHS.findIndex((mm) => mm === m[1]) + 1 : 0;
  return m && month ? { year: Number(m[2]), month } : null;
}

/** "this/current/latest month" -> the latest reported period; "last/previous month" -> the one before it. */
function findMonthPeriod(question: string, latest: Period | null): Period | null {
  if (!latest) return null;
  const q = question.toLowerCase();
  if (/\b(this|current|latest)\s+month\b/.test(q)) return latest;
  if (/\b(last|previous|prior)\s+month\b/.test(q)) return shiftMonth(latest, -1);
  return null;
}

/** Explicit "compare to last year/month", "vs last", "year-on-year", "MoM" etc. — not just any "compare". */
function wantsTimeComparison(question: string): boolean {
  const q = question.toLowerCase();
  if (/\byoy\b|\bmom\b|year[- ]on[- ]year|month[- ]on[- ]month/.test(q)) return true;
  return /\b(compare|compared|comparison|vs\.?|versus|change)\b/.test(q) && /\b(last|previous|prior)\b/.test(q);
}

const FOOTER = "\n\nOffline assistant (rule-based). Add an `ANTHROPIC_API_KEY` to enable the full AI analyst for free-form questions.";

export async function answerOffline(question: string): Promise<string> {
  const q = question.toLowerCase();
  const overview = await dataOverview();
  const lastYear = Number(overview.data_years.split("–")[1]);
  const index = await getAreaIndex();
  const area = findArea(index, question);
  let { from, to } = findYears(question, lastYear);
  let months = findMonths(question);
  const scopeName = area?.label ?? "Bangladesh";

  // "this/current/last/previous month" resolves against the latest reported data month (surveillance
  // data lags the calendar), and overrides the year/month scope for every branch below.
  const latestPeriod = parseLatestPeriod(overview.latest_data_month);
  const monthPeriod = findMonthPeriod(question, latestPeriod);
  if (monthPeriod) {
    from = monthPeriod.year;
    to = monthPeriod.year;
    months = [monthPeriod.month];
  }

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

  // "cases in X compared to last year/month" — one area (or national), two time periods, real deltas.
  // Uses an explicit "20XX" in the question if given, else the latest year — never the `to` from
  // findYears, since its own "last year" phrase-handling would otherwise collide with this branch's.
  if (wantsTimeComparison(q)) {
    const monthly = /\bmonth\b/.test(q) && latestPeriod;
    const explicitYears = [...q.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
    const curYear = explicitYears.length ? explicitYears[explicitYears.length - 1] : lastYear;
    const curLabel = monthly ? periodLabel(latestPeriod!) : String(curYear);
    const prevPeriod = monthly ? shiftMonth(latestPeriod!, -1) : null;
    const prevLabel = monthly ? periodLabel(prevPeriod!) : String(curYear - 1);
    const areaArg = area ? (area.district ?? area.division) : undefined;
    const level = area?.level === "upazila" ? undefined : area?.level;
    const [curStats, prevStats] = await Promise.all([
      malariaStats({ area: areaArg, level, yearFrom: monthly ? latestPeriod!.year : curYear, yearTo: monthly ? latestPeriod!.year : curYear, months: monthly ? [latestPeriod!.month] : undefined }),
      malariaStats({ area: areaArg, level, yearFrom: monthly ? prevPeriod!.year : curYear - 1, yearTo: monthly ? prevPeriod!.year : curYear - 1, months: monthly ? [prevPeriod!.month] : undefined }),
    ]);
    if (!("error" in curStats) && !("error" in prevStats)) {
      const c = curStats.rows[0];
      const p = prevStats.rows[0];
      const line = (label: string, curV: number | null | undefined, prevV: number | null | undefined, digits = 0) => {
        if (curV == null || prevV == null) return `- ${label}: **${n(curV, digits)}** vs **${n(prevV, digits)}** (no prior data to compare)`;
        const d = prevV > 0 ? ((curV - prevV) / prevV) * 100 : null;
        const dTxt = d === null ? "n/a (previous period was zero)" : `${d >= 0 ? "▲" : "▼"} ${n(Math.abs(d), 1)}%`;
        return `- ${label}: **${n(curV, digits)}** vs **${n(prevV, digits)}** (${dTxt})`;
      };
      if (!c && !p) return `No malaria reports were found for ${scopeName} in ${curLabel} or ${prevLabel}.${FOOTER}`;
      return `**${scopeName} — ${curLabel} vs ${prevLabel}**
${line("Confirmed cases", c?.cases, p?.cases)}
${line("Deaths", c?.deaths, p?.deaths)}
${line("Tested", c?.tests, p?.tests)}
${line("Test positivity", c?.tpr_pct, p?.tpr_pct, 2)}${FOOTER}`;
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
    const prevRow = nsp.years.find((y) => y.year === row.year - 1);
    const pct = (v: number | null) => (v === null ? "—" : `${n(v, 1)}%`);
    const chg = (curV: number | null, prevV: number | null) =>
      curV === null || prevV === null ? "—" : prevV > 0 ? `${curV >= prevV ? "▲" : "▼"} ${n(Math.abs(((curV - prevV) / prevV) * 100), 1)}%` : curV > 0 ? "new (was 0)" : "no change";
    const prevLine = prevRow
      ? `\n\n**Vs ${prevRow.year}:** cases ${n(prevRow.actual_cases)} (${chg(row.actual_cases, prevRow.actual_cases)}) · API ${n(prevRow.api_actual, 2)} (${chg(row.api_actual, prevRow.api_actual)}) · ABER ${pct(prevRow.aber_actual_pct)} · deaths ${n(prevRow.actual_deaths)} (${chg(row.actual_deaths, prevRow.actual_deaths)})`
      : `\n\n_No data for ${row.year - 1} to compare against._`;
    return `**Population, API/ABER and NSP targets — ${nsp.scope}, ${row.year}**
- Population at risk: **${n(row.population)}**
- Confirmed cases: **${n(row.actual_cases)}**${row.months_reported < 12 ? ` (${row.months_reported} months reported)` : ""} · NSP target **${n(row.nsp_cases)}** · expected (actual + forecast) **${n(row.expected_cases)}**
- API: **${n(row.api_actual, 2)}** per 1,000 · NSP target ${n(row.nsp_api, 2)}
- ABER: **${pct(row.aber_actual_pct)}** · NSP target ${pct(row.nsp_aber_pct)}
- Tests: ${n(row.actual_tests)} · NSP target ${n(row.nsp_tests)}
- Deaths: ${n(row.actual_deaths)} · NSP target ${n(row.nsp_deaths, 1)}
${prevLine}

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
  const areaArg = area ? (area.level === "upazila" ? question.match(new RegExp(area.label.split(" ")[0], "i"))?.[0] ?? area.label : area.district ?? area.division) : undefined;
  const stats = await malariaStats({
    area: areaArg,
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

  // Every single-period answer — not just ones that ask for it explicitly — also states the
  // previous equivalent period (same month a year earlier when one month is scoped, else the
  // previous year) with the real percent change, so "current vs previous" never needs magic words.
  let comparisonNote = "";
  const effYear = to ?? lastYear;
  const singlePeriod = from === undefined || from === effYear;
  if (singlePeriod) {
    const prevYear = effYear - 1;
    const prevStats = await malariaStats({ area: areaArg, level: area?.level, yearFrom: prevYear, yearTo: prevYear, months });
    if (!("error" in prevStats) && prevStats.rows[0]) {
      const p = prevStats.rows[0];
      const chg = (curV: number, prevV: number) => (prevV > 0 ? `${curV >= prevV ? "▲" : "▼"} ${n(Math.abs(((curV - prevV) / prevV) * 100), 1)}%` : curV > 0 ? "new (was 0)" : "no change");
      const periodNote = months?.length === 1 ? `${MONTHS[months[0] - 1]} ${prevYear}` : String(prevYear);
      comparisonNote = `\n\n**Vs ${periodNote}:** cases ${n(p.cases)} (${chg(r.cases, p.cases)}) · deaths ${n(p.deaths)} (${chg(r.deaths, p.deaths)}) · tested ${n(p.tests)} (${chg(r.tests, p.tests)}) · TPR ${n(p.tpr_pct, 2)}%`;
    } else {
      comparisonNote = `\n\n_No data for ${prevYear} to compare against._`;
    }
  }

  return `**${stats.scope} — ${stats.period}** (data up to ${stats.latest_data_month})\n- Confirmed cases: **${n(r.cases)}** (P. falciparum ${n(r.pf)}, P. vivax ${n(r.pv)}, mixed ${n(r.mixed)}; Pf+mixed share ${n(r.pf_share_pct, 1)}%)\n- Deaths: **${n(r.deaths)}** (case fatality ${n(r.cfr_pct, 3)}%)\n- Tested: **${n(r.tests)}** — test positivity **${n(r.tpr_pct, 2)}%**\n- Severe: ${n(r.severe)} · Treated: ${n(r.treated_pct, 1)}% · Pregnant women: ${n(r.pregnant)}\n- Age: <1 ${n(r.age_under1)}, 1–4 ${n(r.age_1_4)}, 5–14 ${n(r.age_5_14)}, 15+ ${n(r.age_15_plus)} · Male ${n(r.male)}, female ${n(r.female)}${comparisonNote}${FOOTER}`;
}
