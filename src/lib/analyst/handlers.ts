/**
 * Handlers for every intent other than plain statistics: situation brief, "why did it change",
 * live unusual-rise detection, forecasts, weather, climate links, alerts, NSP/population, lists and data info.
 * All database access is read-only (see store.ts).
 */
import {
  climateCorrelation, dataOverview, getForecast, getWeather, recentAlerts,
} from "@/lib/agent-data";
import { MODEL_LABEL } from "@/lib/chart-theme";
import { canonicalGeoName } from "@/lib/malaria-metrics";
import { nspComparison } from "@/lib/nsp";
import { areaWhere, runAgg, runFixed, type AggRow, type RunLog } from "./query";
import type { AreaLookup, AreaSel } from "./areas";
import { GLOSSARY, STARTERS, CAPABILITIES, metricOf } from "./catalog";
import { cellFormat, fmtMetric, labelG, pretty } from "./format";
import type { Parsed } from "./nlu";
import type { Bounds } from "./store";
import { arrowPct, fmtN, joinList, pctChange, pluralize } from "./text";
import { SHORT, labelRange, monthOfP, plabel, pOf, yearOfP } from "./time";
import type { AnalystReply, Cell, ChartSpec, TableSpec } from "./types";

export type Part = Pick<AnalystReply, "text" | "suggestions"> & Partial<Pick<AnalystReply, "table" | "chart" | "kind">> & { scope?: string; period?: string };

const num = (row: AggRow | undefined, key: string): number | null => (typeof row?.[key] === "number" ? (row[key] as number) : null);
const scopeLabel = (a?: AreaSel) => a?.label ?? "Bangladesh";
const shortName = (a?: AreaSel) => (a ? a.label.replace(/ (division|district)$/, "").replace(/ upazila.*$/, "") : "Bangladesh");

function childLevel(scope?: AreaSel): "district" | "upazila" | null {
  if (!scope || scope.level === "division" || scope.level === "group") return "district";
  if (scope.level === "district") return "upazila";
  return null;
}

/** The window the user asked for, or the last 12 months. */
function window(p: Parsed, bounds: Bounds): { from: number; to: number; label: string; assumed: boolean; months?: number[] } {
  if (p.time && p.time.from >= 0) return { from: p.time.from, to: p.time.to, label: labelRange(p.time.from, p.time.to, bounds.latestP), assumed: false, months: p.time.months };
  return { from: bounds.latestP - 11, to: bounds.latestP, label: labelRange(bounds.latestP - 11, bounds.latestP, bounds.latestP), assumed: true, months: p.time?.months };
}

/* ------------------------------ situation brief ------------------------------ */

export async function brief(p: Parsed, bounds: Bounds, log: RunLog): Promise<Part> {
  const scope = p.areas[0];
  const areas = scope ? [scope] : [];
  const w = window(p, bounds);
  const len = w.to - w.from + 1;
  const shift = len <= 12 ? 12 : len;
  const hasPrev = w.from - shift >= pOf(bounds.firstYear, 1);
  const name = scopeLabel(scope);

  const keys = ["cases", "deaths", "tests", "tpr", "pf_share", "severe_pct", "cfr", "under15", "female", "male", "pregnant", "pv", "pf", "mixed"].map(metricOf);
  const q = { metrics: keys, group: "none" as const, areas, months: w.months };
  const [cur] = await runAgg({ ...q, from: w.from, to: w.to }, log, `Headline figures for ${name}`);
  const prev = hasPrev ? (await runAgg({ ...q, from: w.from - shift, to: w.to - shift }, log, "Previous equivalent period"))[0] : undefined;
  if (num(cur, "cases") === null && num(cur, "tests") === null) {
    return { text: `I found no reports for **${name}** in ${w.label}.`, suggestions: ["What data period do you have?", "Give me a situation brief for Bangladesh"] };
  }

  const child = childLevel(scope);
  let children: AggRow[] = [];
  if (child) {
    children = await runAgg(
      { metrics: ["cases", "deaths", "tests", "tpr"].map(metricOf), group: child, areas, from: w.from, to: w.to, months: w.months, order: { by: metricOf("cases"), dir: "desc" }, limit: 8 },
      log,
      `Top ${child === "district" ? "districts" : "upazilas"} by cases`,
    );
  }
  const seriesFrom = Math.max(pOf(bounds.firstYear, 1), bounds.latestP - 35);
  const series = await runAgg({ metrics: [metricOf("cases")], group: "month", areas, from: seriesFrom, to: bounds.latestP, order: undefined }, log, "Monthly cases, last 36 months");

  const c = (k: string) => num(cur, k);
  const pc = (k: string) => num(prev, k);
  const ch = pctChange(c("cases"), pc("cases"));
  let text = `## ${name} — situation brief (${w.label})\n\n`;
  text += `**${fmtN(c("cases"))}** confirmed ${c("cases") === 1 ? "case" : "cases"} and **${fmtN(c("deaths"))}** ${c("deaths") === 1 ? "death" : "deaths"}`;
  text += hasPrev ? ` — cases are ${arrowPct(ch)} vs ${labelRange(w.from - shift, w.to - shift, bounds.latestP)} (${fmtN(pc("cases"))}).` : ".";
  text += ` **${fmtN(c("tests"))}** ${c("tests") === 1 ? "person was" : "people were"} tested, giving a test positivity of **${fmtMetric(metricOf("tpr"), c("tpr"))}**${hasPrev && pc("tpr") !== null ? ` (${fmtMetric(metricOf("tpr"), pc("tpr"))} before)` : ""}.`;
  if ((c("tests") ?? 0) > 0 && (c("tests") ?? 0) < 100) text += ` _That rate rests on only ${fmtN(c("tests"))} ${c("tests") === 1 ? "test" : "tests"}, so treat it with caution._`;
  text += "\n";

  const bullets: string[] = [];
  const totalCases = c("cases") ?? 0;
  if (children.length && totalCases > 0) {
    const topK = children.slice(0, 3);
    const nm = (g: string | number | null) => (scope?.level === "district" ? labelG(child!, g).replace(/ \(.*\)$/, "") : labelG(child!, g));
    const share = topK.reduce((s, r) => s + (num(r, "cases") ?? 0), 0) / totalCases;
    bullets.push(`**Where:** ${joinList(topK.map((r) => `${nm(r.g)} (${fmtN(num(r, "cases"))})`))} lead — together ${fmtN(share * 100, 0)}% of cases.`);
  }
  const monthly = series.sort((a, b) => Number(a.g) - Number(b.g));
  if (monthly.length >= 6) {
    const pk = [...monthly].sort((a, b) => (num(b, "cases") ?? 0) - (num(a, "cases") ?? 0))[0];
    const last = monthly[monthly.length - 1];
    const yagoRow = monthly.find((r) => Number(r.g) === Number(last.g) - 100);
    const yoy = pctChange(num(last, "cases"), num(yagoRow, "cases"));
    bullets.push(`**When:** the busiest month in the last 36 months was **${labelG("month", pk.g)}** (${fmtN(num(pk, "cases"))} cases); the latest month, ${labelG("month", last.g)}, had ${fmtN(num(last, "cases"))}${yoy !== null ? ` (${arrowPct(yoy)} vs a year earlier)` : ""}.`);
  }
  if (c("pf_share") !== null && totalCases > 0) {
    bullets.push(`**Parasite:** falciparum (incl. mixed) makes up **${fmtN(c("pf_share"), 0)}%** of cases and vivax **${fmtN(((c("pv") ?? 0) / totalCases) * 100, 0)}%** — vivax needs radical cure to prevent relapse.`);
  }
  if (totalCases > 0 && c("under15") !== null) {
    bullets.push(`**Who:** children under 15 are ${fmtN(((c("under15") ?? 0) / totalCases) * 100, 0)}% of cases; ${fmtN((((c("male") ?? 0) / Math.max(1, (c("male") ?? 0) + (c("female") ?? 0))) * 100), 0)}% are male${(c("pregnant") ?? 0) > 0 ? `; ${fmtN(c("pregnant"))} pregnant ${c("pregnant") === 1 ? "woman" : "women"}` : ""}.`);
  }
  if ((c("deaths") ?? 0) > 0) bullets.push(`**Severity:** case fatality ${fmtMetric(metricOf("cfr"), c("cfr"))}; severe cases are ${fmtN(c("severe_pct"), 1)}% of confirmed cases.`);
  if (bullets.length) text += `\n${bullets.map((b) => `- ${b}`).join("\n")}`;

  const table: TableSpec | undefined = children.length
    ? {
        columns: [
          { key: "area", label: child === "district" ? "District" : "Upazila", format: "text" },
          ...["cases", "deaths", "tests", "tpr"].map((k) => ({ key: k, label: metricOf(k).label, format: cellFormat(metricOf(k)) })),
          { key: "share", label: "% of cases", format: "pct1" as const },
        ],
        rows: children.map((r) => ({
          area: scope?.level === "district" ? labelG(child!, r.g).replace(/ \(.*\)$/, "") : labelG(child!, r.g),
          cases: num(r, "cases"), deaths: num(r, "deaths"), tests: num(r, "tests"), tpr: num(r, "tpr"),
          share: totalCases > 0 && num(r, "cases") !== null ? (num(r, "cases")! / totalCases) * 100 : null,
        })),
      }
    : undefined;
  const chart: ChartSpec | undefined = monthly.length >= 3
    ? { kind: "line", title: `Confirmed cases by month — ${name}`, xKey: "g", series: [{ key: "cases", label: "Confirmed cases" }], rows: monthly.map((r) => ({ g: labelG("month", r.g), cases: num(r, "cases") })), format: "int" }
    : undefined;

  const sg = [`Why did cases change in ${shortName(scope)} compared to last year?`, `Forecast cases for ${shortName(scope)}`];
  if (child) sg.unshift(`Which ${child === "district" ? "districts" : "upazilas"} have the most cases ${scope ? `in ${shortName(scope)}` : ""}?`.replace(" ?", "?"));
  return { text, table, chart, suggestions: sg.slice(0, 3), scope: name, period: w.label };
}

/* ------------------------------ why did it change ------------------------------ */

export async function explain(p: Parsed, bounds: Bounds, log: RunLog): Promise<Part> {
  const scope = p.areas[0];
  const areas = scope ? [scope] : [];
  const w = window(p, bounds);
  const len = w.to - w.from + 1;
  const shift = p.compare?.kind === "mom" ? Math.max(1, len) : p.compare?.kind === "prev" ? len : len <= 12 ? 12 : len;
  const name = scopeLabel(scope);
  if (w.from - shift < pOf(bounds.firstYear, 1)) {
    return { text: `The data begin in ${bounds.firstYear}, so there is no earlier period to compare ${w.label} with.`, suggestions: ["What data period do you have?"] };
  }
  const metricKey = p.metrics.find((k) => k === "deaths" || k === "cases") ?? "cases";
  const M = metricOf(metricKey);
  const prevLabel = labelRange(w.from - shift, w.to - shift, bounds.latestP);

  const tot = ["cases", "deaths", "tests", "tpr", "pf", "pv", "mixed", "pf_share", "upazilas_with_cases", "reporting_units"].map(metricOf);
  const base = { areas, months: w.months, group: "none" as const };
  const [cur] = await runAgg({ ...base, metrics: tot, from: w.from, to: w.to }, log, `${name}: current period`);
  const [prev] = await runAgg({ ...base, metrics: tot, from: w.from - shift, to: w.to - shift }, log, `${name}: comparison period`);
  const cv = num(cur, metricKey), pv = num(prev, metricKey);
  if (cv === null || pv === null) return { text: `I could not find reports for ${name} in both ${w.label} and ${prevLabel}.`, suggestions: ["What data period do you have?"] };
  const delta = cv - pv;
  const pct = pctChange(cv, pv);
  const dirWord = delta === 0 ? "did not change" : delta < 0 ? "fell" : "rose";

  let text = `## Why ${M.label.toLowerCase()} ${dirWord} in ${name}\n\n**${w.label}: ${fmtN(cv)}** vs **${prevLabel}: ${fmtN(pv)}** — ${arrowPct(pct)} (${delta >= 0 ? "+" : "−"}${fmtN(Math.abs(delta))}).\n`;
  if (delta === 0) text += "\nThere is no change to decompose.";

  // where
  const child = childLevel(scope);
  let table: TableSpec | undefined;
  let chart: ChartSpec | undefined;
  if (child) {
    const [a, b] = await Promise.all([
      runAgg({ metrics: [M], group: child, areas, from: w.from, to: w.to, months: w.months }, log, `${M.label} by ${child}, current`),
      runAgg({ metrics: [M], group: child, areas, from: w.from - shift, to: w.to - shift, months: w.months }, log, `${M.label} by ${child}, comparison`),
    ]);
    const prevMap = new Map(b.map((r) => [String(r.g), num(r, metricKey) ?? 0]));
    const keys = new Set([...a.map((r) => String(r.g)), ...b.map((r) => String(r.g))]);
    const curMap = new Map(a.map((r) => [String(r.g), num(r, metricKey) ?? 0]));
    const contrib = [...keys].map((k) => ({ k: pretty(k), cur: curMap.get(k) ?? 0, prev: prevMap.get(k) ?? 0, d: (curMap.get(k) ?? 0) - (prevMap.get(k) ?? 0) }));
    const sameDir = contrib.filter((x) => (delta < 0 ? x.d < 0 : x.d > 0)).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    const opposite = contrib.filter((x) => (delta < 0 ? x.d > 0 : x.d < 0)).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    if (delta !== 0 && sameDir.length) {
      const top = sameDir.slice(0, 3);
      const share = top.reduce((s, x) => s + x.d, 0) / delta;
      text += `\n**Where it came from.** ${joinList(top.map((x) => `**${x.k}** (${x.d > 0 ? "+" : "−"}${fmtN(Math.abs(x.d))})`))} account for **${fmtN(share * 100, 0)}%** of the net ${delta < 0 ? "fall" : "rise"}`;
      text += opposite.length ? `, partly offset by ${joinList(opposite.slice(0, 2).map((x) => `${x.k} (${x.d > 0 ? "+" : "−"}${fmtN(Math.abs(x.d))})`))}.` : ".";
    }
    const shown = [...sameDir.slice(0, 6), ...opposite.slice(0, 3)].sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 8);
    table = {
      columns: [
        { key: "area", label: child === "district" ? "District" : "Upazila", format: "text" },
        { key: "cur", label: `${M.label} — ${w.label}`, format: "int" },
        { key: "prev", label: `${M.label} — ${prevLabel}`, format: "int" },
        { key: "d", label: "Change", format: "int" },
        { key: "share", label: "% of net change", format: "pct1" },
      ],
      rows: shown.map((x) => ({ area: x.k, cur: x.cur, prev: x.prev, d: x.d, share: delta !== 0 ? (x.d / delta) * 100 : null })),
    };
    chart = { kind: "hbar", title: `Change in ${M.label.toLowerCase()} by ${child}`, xKey: "area", series: [{ key: "d", label: "Change" }], rows: shown.map((x) => ({ area: x.k, d: x.d })), format: "int" };
  }

  // species
  const pfShare = [num(cur, "pf_share"), num(prev, "pf_share")];
  if (pfShare[0] !== null && pfShare[1] !== null) {
    text += `\n\n**Species.** Falciparum (incl. mixed) went from ${fmtN(pfShare[1], 0)}% to ${fmtN(pfShare[0], 0)}% of cases; P. falciparum ${fmtN(num(prev, "pf"))} → ${fmtN(num(cur, "pf"))}, P. vivax ${fmtN(num(prev, "pv"))} → ${fmtN(num(cur, "pv"))}.`;
  }
  // testing effort
  const tc = num(cur, "tests"), tp = num(prev, "tests");
  if (tc !== null && tp !== null && tp > 0) {
    const tch = pctChange(tc, tp);
    const cch = pct ?? 0;
    const sameWay = (tch ?? 0) * cch > 0;
    text += `\n\n**Testing effort.** People tested went from ${fmtN(tp)} to ${fmtN(tc)} (${arrowPct(tch)}) and positivity from ${fmtMetric(metricOf("tpr"), num(prev, "tpr"))} to ${fmtMetric(metricOf("tpr"), num(cur, "tpr"))}. `;
    text += sameWay && Math.abs(tch ?? 0) >= Math.abs(cch) / 2
      ? "Testing moved in the same direction by a similar amount, so part of the change in cases may simply reflect how many people were tested."
      : "Testing did not move in step with cases, so the change is unlikely to be only a testing artefact.";
  }
  // timing
  if (len >= 3 && len <= 36 && delta !== 0) {
    const [ma, mb] = await Promise.all([
      runAgg({ metrics: [M], group: "month", areas, from: w.from, to: w.to, months: w.months }, log, "Monthly, current"),
      runAgg({ metrics: [M], group: "month", areas, from: w.from - shift, to: w.to - shift, months: w.months }, log, "Monthly, comparison"),
    ]);
    const bMap = new Map(mb.map((r) => [Number(r.g), num(r, metricKey) ?? 0]));
    const swings = ma.map((r) => {
      const g = Number(r.g);
      const prior = bMap.get(g - shift / 12 * 100) ?? bMap.get(g - 100) ?? 0;
      return { g, d: (num(r, metricKey) ?? 0) - prior };
    }).sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 3);
    if (swings.length && shift % 12 === 0) text += `\n\n**Timing.** The biggest monthly differences were ${joinList(swings.map((s) => `${labelG("month", s.g)} (${s.d > 0 ? "+" : "−"}${fmtN(Math.abs(s.d))})`))}.`;
  }
  // coverage
  const rc = num(cur, "reporting_units"), rp = num(prev, "reporting_units");
  if (rc !== null && rp !== null && rc !== rp) {
    text += `\n\n**Reporting.** ${fmtN(rc)} upazilas reported in ${w.label} vs ${fmtN(rp)} before — a change in reporting coverage can move totals on its own.`;
  }
  text += "\n\n_These are the data-based contributors to the change. They show where and how it changed, not proven causes — field factors such as weather, interventions and population movement need local investigation._";
  return {
    text, table, chart, scope: name, period: `${w.label} vs ${prevLabel}`,
    suggestions: [`Monthly trend for ${shortName(scope)}`, "Does rainfall affect malaria cases?", `Forecast cases for ${shortName(scope)}`],
  };
}

/* ------------------------------ unusual-rise detection ------------------------------ */

export async function signals(p: Parsed, bounds: Bounds, log: RunLog): Promise<Part> {
  const scope = p.areas[0];
  const target = p.time && p.time.from >= 0 ? p.time.to : bounds.latestP;
  const y = yearOfP(target), m = monthOfP(target);
  const lvl = scope?.level === "district" ? "upazila" : "district";
  const params: unknown[] = [];
  const ph = (v: unknown, cast: string) => { params.push(v); return `$${params.length}::${cast}`; };
  const levelExpr = lvl === "upazila" ? "(m.upazila_name || ' (' || m.district_name || ')')" : "m.district_name";
  const yP = ph(y, "int"), mP = ph(m, "int");
  const where = scope ? `WHERE ${areaWhere([scope], ph)}` : "";
  const rows = await runFixed<{ a: string; observed: number; mean: number; sd: number; n: number; z: number }>(
    `WITH monthly AS (
  SELECT ${levelExpr} AS a, m.report_year AS y, m.report_month AS mo, sum(m.cases)::float8 AS c
  FROM mis_monthly m ${where}
  GROUP BY 1, 2, 3
), cur AS (
  SELECT a, c FROM monthly WHERE y = ${yP} AND mo = ${mP}
), base AS (
  SELECT cur.a, cur.c AS observed, avg(h.c) AS mean, stddev_samp(h.c) AS sd, count(h.c)::int AS n
  FROM cur JOIN monthly h ON h.a = cur.a AND h.mo = ${mP} AND h.y BETWEEN ${yP} - 5 AND ${yP} - 1
  GROUP BY cur.a, cur.c
)
SELECT a, observed, mean::float8, coalesce(sd, 0)::float8 AS sd, n,
       ((observed - mean) / greatest(coalesce(sd, 0), sqrt(greatest(mean, 1))))::float8 AS z
FROM base WHERE n >= 3
ORDER BY z DESC
LIMIT 40`,
    params, log, `Compare ${plabel(target)} with the same month in the previous 5 years`,
  );
  const status = (r: { observed: number; z: number }) => (r.observed < 5 ? "Normal" : r.z >= 3 ? "Strong signal" : r.z >= 2 ? "Signal" : r.z >= 1 ? "Elevated" : "Normal");
  const flagged = rows.filter((r) => status(r) === "Signal" || status(r) === "Strong signal");
  const name = scopeLabel(scope);
  const unit = lvl === "upazila" ? "upazilas" : "districts";
  let text: string;
  if (!rows.length) {
    text = `There is not enough history (at least 3 earlier years of ${SHORT[m - 1]} reports) to judge ${plabel(target)} for ${name}.`;
  } else if (flagged.length) {
    const top = flagged[0];
    text = `**${flagged.length} of ${rows.length} ${unit}** in ${name} are above their usual range for **${plabel(target)}**. The strongest is **${top.a}** with **${fmtN(top.observed)}** cases against an expected ~${fmtN(top.mean, 1)} (signal index ${fmtN(top.z, 1)}).`;
  } else {
    const el = rows.filter((r) => status(r) === "Elevated");
    text = `**No ${lvl} in ${name} is above its usual range for ${plabel(target)}.** ${el.length ? `${el.length} ${unit} are slightly elevated (index 1–2): ${joinList(el.slice(0, 3).map((r) => r.a))}.` : "Case counts are within what that month normally shows."}`;
  }
  text += `\n\n_Method: each area's cases in ${plabel(target)} are compared with the same month in the previous 5 years (mean ± SD, SD floored at √mean). Index ≥ 2 = signal, ≥ 3 = strong signal; areas with fewer than 5 cases are never flagged. Index 0–1 is normal variation._`;
  const shown = rows.slice(0, 10);
  return {
    text, scope: name, period: plabel(target),
    table: {
      columns: [
        { key: "a", label: lvl === "upazila" ? "Upazila" : "District", format: "text" },
        { key: "observed", label: `Cases ${plabel(target)}`, format: "int" },
        { key: "mean", label: "Expected (5-yr mean)", format: "d1" },
        { key: "z", label: "Signal index", format: "d1" },
        { key: "status", label: "Status", format: "text" },
      ],
      rows: shown.map((r) => ({ a: r.a, observed: r.observed, mean: r.mean, z: r.z, status: status(r) })),
    },
    chart: shown.length ? { kind: "hbar", title: `Signal index by ${lvl} — ${plabel(target)}`, xKey: "a", series: [{ key: "z", label: "Signal index" }], rows: shown.map((r) => ({ a: r.a, z: Math.round(r.z * 10) / 10 })), format: "d1" } : undefined,
    suggestions: ["Recent death and surge alerts", `Monthly trend for ${flagged[0]?.a.replace(/ \(.*$/, "") ?? "Bangladesh"}`, "Why did cases change compared to last year?"],
  };
}

/* ------------------------------ forecast ------------------------------ */

function scopeArg(sel?: AreaSel): { area?: string; level?: "division" | "district"; ok: boolean } {
  if (!sel) return { ok: true };
  if (sel.level === "division") return { area: sel.division, level: "division", ok: true };
  if (sel.level === "district") return { area: sel.districts?.[0], level: "district", ok: true };
  return { ok: false };
}

export async function forecast(p: Parsed, bounds: Bounds, log: RunLog): Promise<Part> {
  const sel = p.areas[0];
  const arg = scopeArg(sel);
  const target = p.forecastTarget;
  const note = sel && !arg.ok ? `Forecasts exist for Bangladesh, each division and each district — not for ${sel.label}. Showing Bangladesh instead.\n\n` : "";
  const f = await getForecast({ area: arg.ok ? arg.area : undefined, target, level: arg.level });
  log.sql.push(`-- Stored model output (python pipeline/forecast.py)\nSELECT year, month, yhat, lo80, hi80 FROM forecast_monthly WHERE target = '${target}' AND level = '${arg.level ?? "national"}'${arg.ok && arg.area ? ` AND area_key = '${canonicalGeoName(arg.area)}'` : ""} ORDER BY year, month;`);
  const points = "forecast" in f ? f.forecast : undefined;
  if (!f.available || !points) return { text: `${note}${"note" in f ? f.note : "No forecast is stored for this area."}`, suggestions: ["Forecast cases for Bangladesh", "Monthly trend for Bangladesh"] };

  const name = arg.ok && sel ? sel.label : "Bangladesh";
  const futureAll = points.filter((r) => pOf(Number(r.year), Number(r.month)) > bounds.latestP);
  const future = (futureAll.length ? futureAll : points).slice(0, Math.min(p.horizon ?? 6, 12));
  const run = (f.run ?? {}) as Record<string, unknown>;
  const model = MODEL_LABEL[String(run.model)] ?? String(run.model ?? "—");
  const total = future.reduce((s, r) => s + Number(r.predicted), 0);
  const peak = [...future].sort((a, b) => Number(b.predicted) - Number(a.predicted))[0];
  const loSum = future.reduce((s, r) => s + Number(r.lo80), 0), hiSum = future.reduce((s, r) => s + Number(r.hi80), 0);

  // same months a year earlier, for context
  const first = future[0], last = future[future.length - 1];
  const fromP = pOf(Number(first.year), Number(first.month)) - 12, toP = pOf(Number(last.year), Number(last.month)) - 12;
  const areas = arg.ok && sel ? [sel] : [];
  const [lastYear] = await runAgg({ metrics: [metricOf(target)], group: "none", areas, from: fromP, to: toP }, log, "Same months one year earlier");
  const ly = num(lastYear, target);
  const history = await runAgg({ metrics: [metricOf(target)], group: "month", areas, from: bounds.latestP - 17, to: bounds.latestP }, log, `Actual ${target}, last 18 months`);

  let text = `${note}## ${target === "deaths" ? "Death" : "Case"} forecast — ${name}\n\n`;
  text += `Over the next **${future.length} ${pluralize(future.length, "month")}** (${plabel(pOf(Number(first.year), Number(first.month)))} – ${plabel(pOf(Number(last.year), Number(last.month)))}) the model expects about **${fmtN(total)}** ${target}`;
  text += ` (80% range ${fmtN(loSum)}–${fmtN(hiSum)})`;
  if (ly !== null) text += `, ${arrowPct(pctChange(total, ly))} vs ${fmtN(ly)} in the same months a year earlier`;
  text += `. The highest month is expected to be **${plabel(pOf(Number(peak.year), Number(peak.month)))}** (~${fmtN(Number(peak.predicted))}).\n\n`;
  text += `- **Model:** ${model}\n`;
  if (run.accuracy_pct != null) text += `- **Back-tested accuracy:** ${fmtN(Number(run.accuracy_pct), 0)}%${run.accuracy_3m_pct != null ? ` (${fmtN(Number(run.accuracy_3m_pct), 0)}% for the first 3 months)` : ""} over ${run.backtest_origins ?? "—"} test origins\n`;
  text += `- **Trained on:** ${run.train_start ?? "—"} to ${run.train_end ?? "—"}\n\n_A forecast is a statistical projection, not a certainty: the further ahead, the wider the uncertainty. Use the 80% range for planning._`;

  const hist = history.sort((a, b) => Number(a.g) - Number(b.g));
  const rows: Record<string, Cell>[] = [
    ...hist.map((r, i) => ({ g: labelG("month", r.g), actual: num(r, target), ...(i === hist.length - 1 ? { predicted: num(r, target) } : {}) } as Record<string, Cell>)),
    ...future.map((r) => ({ g: plabel(pOf(Number(r.year), Number(r.month))), predicted: Math.round(Number(r.predicted) * 10) / 10, lo80: Math.round(Number(r.lo80) * 10) / 10, hi80: Math.round(Number(r.hi80) * 10) / 10 } as Record<string, Cell>)),
  ];
  return {
    text,
    table: {
      columns: [
        { key: "g", label: "Month", format: "text" },
        { key: "predicted", label: `Predicted ${target}`, format: "d1" },
        { key: "lo80", label: "80% low", format: "d1" },
        { key: "hi80", label: "80% high", format: "d1" },
      ],
      rows: future.map((r) => ({ g: plabel(pOf(Number(r.year), Number(r.month))), predicted: Number(r.predicted), lo80: Number(r.lo80), hi80: Number(r.hi80) })),
    },
    chart: { kind: "line", title: `${target === "deaths" ? "Deaths" : "Cases"}: actual and forecast — ${name}`, xKey: "g", series: [{ key: "actual", label: "Actual" }, { key: "predicted", label: "Forecast" }, { key: "lo80", label: "80% low" }, { key: "hi80", label: "80% high" }], rows, format: "int" },
    suggestions: [target === "cases" ? `Forecast deaths for ${shortName(sel)}` : `Forecast cases for ${shortName(sel)}`, `Why did cases change in ${shortName(sel)} compared to last year?`, `How accurate is the forecast for ${shortName(sel)}?`].slice(0, 3),
  };
}

/* ------------------------------ weather & climate ------------------------------ */

export async function weather(p: Parsed, bounds: Bounds, log: RunLog): Promise<Part> {
  const sel = p.areas[0];
  const arg = scopeArg(sel);
  const w = window(p, bounds);
  const yearly = w.to - w.from + 1 > 24;
  const res = await getWeather({ area: arg.ok ? arg.area : undefined, level: arg.level, yearFrom: yearOfP(w.from), yearTo: yearOfP(w.to), groupBy: yearly ? "year" : "month" });
  log.sql.push(`-- ERA5 reanalysis (Open-Meteo), table weather_district_monthly\nSELECT year, month, avg(temp_mean), avg(precip_mm), avg(rh_mean) FROM weather_district_monthly WHERE year BETWEEN ${yearOfP(w.from)} AND ${yearOfP(w.to)} GROUP BY year, month ORDER BY year, month;`);
  if (!res.available || !("rows" in res)) return { text: "note" in res ? String(res.note) : "No weather data is available.", suggestions: ["Does rainfall affect malaria cases?"] };
  const name = "scope" in res ? res.scope : "Bangladesh";
  const rows = (res.rows as Record<string, unknown>[]).filter((r) => {
    if (yearly) return true;
    const [yy, mm] = String(r.period).split("-").map(Number);
    const pp = pOf(yy, mm);
    return pp >= w.from && pp <= w.to && (!w.months || w.months.includes(mm));
  });
  if (!rows.length) return { text: `No weather rows for ${name} in ${w.label}.`, suggestions: ["Does rainfall affect malaria cases?"] };

  let table: TableSpec, chart: ChartSpec, text: string;
  if (yearly) {
    table = {
      columns: [{ key: "year", label: "Year", format: "text" }, { key: "temp", label: "Mean temp (°C)", format: "d1" }, { key: "rain", label: "Rainfall (mm)", format: "int" }, { key: "rh", label: "Humidity (%)", format: "int" }],
      rows: rows.map((r) => ({ year: String(r.year), temp: Number(r.temp_mean_c), rain: Number(r.rainfall_mm_total), rh: Number(r.humidity_pct) })),
    };
    chart = { kind: "bar", title: `Annual rainfall — ${name}`, xKey: "year", series: [{ key: "rain", label: "Rainfall (mm)" }], rows: table.rows, format: "int" };
    const wet = [...table.rows].sort((a, b) => Number(b.rain) - Number(a.rain))[0];
    text = `**${name}**, ${w.label}: mean temperature ${fmtN(rows.reduce((s, r) => s + Number(r.temp_mean_c), 0) / rows.length, 1)} °C. The wettest year was **${wet.year}** (${fmtN(Number(wet.rain))} mm).`;
  } else {
    table = {
      columns: [{ key: "period", label: "Month", format: "text" }, { key: "temp", label: "Mean temp (°C)", format: "d1" }, { key: "rain", label: "Rainfall (mm)", format: "int" }, { key: "rh", label: "Humidity (%)", format: "int" }],
      rows: rows.map((r) => { const [yy, mm] = String(r.period).split("-").map(Number); return { period: plabel(pOf(yy, mm)), temp: Number(r.temp_mean_c), rain: Number(r.rainfall_mm), rh: Number(r.humidity_pct) }; }),
    };
    chart = { kind: "bar", title: `Monthly rainfall — ${name}`, xKey: "period", series: [{ key: "rain", label: "Rainfall (mm)" }], rows: table.rows, format: "int" };
    const wet = [...table.rows].sort((a, b) => Number(b.rain) - Number(a.rain))[0];
    const hot = [...table.rows].sort((a, b) => Number(b.temp) - Number(a.temp))[0];
    text = `**${name}**, ${w.label}: total rainfall **${fmtN(table.rows.reduce((s, r) => s + Number(r.rain), 0))} mm**. Wettest month **${wet.period}** (${fmtN(Number(wet.rain))} mm); warmest **${hot.period}** (${fmtN(Number(hot.temp), 1)} °C).`;
  }
  text += `\n\n_Source: ${"source" in res ? res.source : "ERA5 reanalysis"}._`;
  return { text, table, chart, suggestions: [`Does rainfall affect malaria cases in ${shortName(sel)}?`, `Monthly cases in ${shortName(sel)}`, `Forecast cases for ${shortName(sel)}`] };
}

export async function climate(p: Parsed, bounds: Bounds, log: RunLog): Promise<Part> {
  const sel = p.areas[0];
  const arg = scopeArg(sel);
  const yearFrom = p.time && p.time.from >= 0 ? yearOfP(p.time.from) : undefined;
  const res = await climateCorrelation({ area: arg.ok ? arg.area : undefined, level: arg.level, yearFrom });
  log.sql.push("-- Spearman rank correlation of monthly cases vs ERA5 weather lagged 0–3 months (computed in the server from mis_monthly and weather_district_monthly)");
  if (!("results" in res) || !res.results) return { text: "note" in res ? String(res.note) : "error" in res ? String(res.error) : "Climate analysis is unavailable.", suggestions: ["Forecast cases for Bangladesh"] };
  const best = new Map<string, { lag: number; rho: number }>();
  for (const r of res.results) {
    if (r.spearman_rho === null) continue;
    const cur = best.get(r.variable);
    if (!cur || Math.abs(r.spearman_rho) > Math.abs(cur.rho)) best.set(r.variable, { lag: r.lag_months, rho: r.spearman_rho });
  }
  const label: Record<string, string> = { rainfall_mm: "Rainfall", temp_mean_c: "Temperature", humidity_pct: "Humidity", dew_point_c: "Dew point", soil_moisture_m3m3: "Soil moisture" };
  const rows = [...best].map(([variable, v]) => ({ variable: label[variable] ?? variable, lag: v.lag, rho: v.rho })).sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
  const s = res.strongest;
  const strength = (r: number) => (Math.abs(r) >= 0.7 ? "strong" : Math.abs(r) >= 0.4 ? "moderate" : Math.abs(r) >= 0.2 ? "weak" : "negligible");
  let text = `## Weather and malaria — ${res.scope}\n\n`;
  if (s && s.spearman_rho !== null) {
    text += `The strongest link is **${(label[s.variable] ?? s.variable).toLowerCase()}** ${s.lag_months === 0 ? "in the same month" : `${s.lag_months} month${s.lag_months > 1 ? "s" : ""} earlier`}: Spearman ρ = **${fmtN(s.spearman_rho, 2)}** (${strength(s.spearman_rho)}, ${s.months} months, ${res.period}).\n\n`;
    text += rows.map((r) => `- ${r.variable}: best at a ${r.lag}-month lag, ρ = ${fmtN(r.rho, 2)} (${strength(r.rho)})`).join("\n");
  }
  text += "\n\n_Correlation shows that two things move together, not that one causes the other. Malaria also follows season, interventions and population movement, which this does not separate._";
  return {
    text,
    table: { columns: [{ key: "variable", label: "Weather variable", format: "text" }, { key: "lag", label: "Best lag (months)", format: "int" }, { key: "rho", label: "Spearman ρ", format: "d2" }], rows },
    chart: { kind: "bar", title: `Correlation with monthly cases (best lag) — ${res.scope}`, xKey: "variable", series: [{ key: "rho", label: "Spearman ρ" }], rows, format: "d2" },
    suggestions: [`Rainfall in ${shortName(sel)} for the last 12 months`, `Forecast cases for ${shortName(sel)}`, `Monthly cases in ${shortName(sel)}`],
  };
}

/* ------------------------------ alerts ------------------------------ */

export async function alerts(p: Parsed, log: RunLog): Promise<Part> {
  const sel = p.areas[0];
  const { alerts: all, rules } = (await recentAlerts({ limit: 60 })) as { alerts: Record<string, unknown>[]; rules?: string };
  log.sql.push("-- Stored alerts written by the daily sync\nSELECT kind, level, division_name, district_name, upazila_name, report_year, report_month, observed, expected FROM alerts ORDER BY report_year DESC, report_month DESC, created_at DESC LIMIT 60;");
  const keep = (a: Record<string, unknown>) => {
    if (!sel) return true;
    if (sel.level === "division") return canonicalGeoName(String(a.division_name ?? "")) === canonicalGeoName(sel.division ?? "");
    return (sel.districts ?? []).some((d) => canonicalGeoName(d) === canonicalGeoName(String(a.district_name ?? "")));
  };
  const list = all.filter(keep).slice(0, 12);
  if (!list.length) return { text: `No stored death or surge alerts${sel ? ` for ${sel.label}` : ""} yet.`, suggestions: ["Any unusual rise in cases this month?", "Monthly trend for Bangladesh"] };
  const deaths = list.filter((a) => a.kind === "death"), surges = list.filter((a) => a.kind !== "death");
  const when = (a: Record<string, unknown>) => `${SHORT[Number(a.report_month) - 1]} ${a.report_year}`;
  let text = `**${list.length} most recent alerts${sel ? ` — ${sel.label}` : ""}:** ${deaths.length} death ${pluralize(deaths.length, "alert")} and ${surges.length} case-surge ${pluralize(surges.length, "alert")}.\n\n`;
  text += list.slice(0, 5).map((a) => (a.kind === "death" ? `- **${a.observed} ${Number(a.observed) === 1 ? "death" : "deaths"}** — ${pretty(String(a.upazila_name ?? a.district_name))}, ${pretty(String(a.district_name))} (${when(a)})` : `- **Surge** — ${pretty(String(a.upazila_name ?? a.district_name))}: ${a.observed} cases vs ~${fmtN(Number(a.expected), 0)} expected (${when(a)})`)).join("\n");
  if (rules) text += `\n\n_Rules: ${rules}_`;
  return {
    text, period: "latest stored alerts",
    table: {
      columns: [{ key: "kind", label: "Type", format: "text" }, { key: "area", label: "Area", format: "text" }, { key: "period", label: "Month", format: "text" }, { key: "observed", label: "Observed", format: "int" }, { key: "expected", label: "Expected", format: "d1" }],
      rows: list.map((a) => ({ kind: a.kind === "death" ? "Death" : "Surge", area: pretty(`${a.upazila_name ?? a.district_name}${a.upazila_name ? `, ${a.district_name}` : ""}`), period: when(a), observed: Number(a.observed), expected: a.expected == null ? null : Number(a.expected) })),
    },
    suggestions: ["Any unusual rise in cases this month?", "Which districts had deaths this year?", "Monthly trend for Bangladesh"],
  };
}

/* ------------------------------ NSP & population ------------------------------ */

export async function nsp(p: Parsed, bounds: Bounds, log: RunLog): Promise<Part> {
  const sel = p.areas[0];
  const district = sel?.level === "district" ? sel.districts?.[0] : undefined;
  const res = await nspComparison({ district });
  log.sql.push("-- population_quantification (NSP workbook) joined with mis_monthly and upazila_population");
  if (!res.available) return { text: res.note, suggestions: ["Give me a situation brief for Bangladesh"] };
  const year = p.time && p.time.from >= 0 ? yearOfP(p.time.to) : bounds.latestP ? yearOfP(bounds.latestP) : res.years[res.years.length - 1].year;
  const row = res.years.find((y) => y.year === year) ?? res.years[res.years.length - 1];
  const prevRow = res.years.find((y) => y.year === row.year - 1);
  const pct = (v: number | null) => (v === null ? "—" : `${fmtN(v, 1)}%`);
  let text = `## Population and NSP targets — ${res.scope}, ${row.year}\n\n`;
  text += `- **Population at risk:** ${fmtN(row.population)}\n- **Confirmed cases:** ${fmtN(row.actual_cases)}${row.months_reported < 12 ? ` (${row.months_reported} months reported)` : ""} vs NSP target ${fmtN(row.nsp_cases)}${row.expected_cases !== null ? `; expected for the full year (actual + forecast) ${fmtN(row.expected_cases)}` : ""}\n`;
  text += `- **API:** ${fmtN(row.api_actual, 2)} per 1,000 (NSP target ${fmtN(row.nsp_api, 2)})\n- **ABER:** ${pct(row.aber_actual_pct)} (target ${pct(row.nsp_aber_pct)})\n- **Tests:** ${fmtN(row.actual_tests)} (target ${fmtN(row.nsp_tests)})\n- **Deaths:** ${fmtN(row.actual_deaths)} (target ${fmtN(row.nsp_deaths, 1)})`;
  if (prevRow) text += `\n\nCompared with ${prevRow.year}: cases ${arrowPct(pctChange(row.actual_cases, prevRow.actual_cases))}, API ${arrowPct(pctChange(row.api_actual, prevRow.api_actual))}.`;
  text += `\n\n_Source file: ${res.source}. ${res.notes.actual_api}_`;
  return {
    text,
    table: {
      columns: [
        { key: "year", label: "Year", format: "text" }, { key: "population", label: "Population", format: "int" }, { key: "actual", label: "Actual cases", format: "int" },
        { key: "target", label: "NSP target", format: "int" }, { key: "api", label: "API", format: "d2" }, { key: "nspApi", label: "NSP API", format: "d2" },
      ],
      rows: res.years.map((y) => ({ year: String(y.year), population: y.population, actual: y.actual_cases, target: y.nsp_cases, api: y.api_actual, nspApi: y.nsp_api })),
    },
    chart: { kind: "bar", title: `Actual cases vs NSP target — ${res.scope}`, xKey: "year", series: [{ key: "actual", label: "Actual cases" }, { key: "target", label: "NSP target" }], rows: res.years.map((y) => ({ year: String(y.year), actual: y.actual_cases, target: y.nsp_cases })), format: "int" },
    suggestions: ["Forecast cases for Bangladesh", "Give me a situation brief for Bangladesh", "What is API?"],
  };
}

/* ------------------------------ lists, data info, glossary, small talk ------------------------------ */

export function list(p: Parsed, lk: AreaLookup): Part {
  const level = p.listLevel!;
  const sel = p.areas[0];
  if (level === "division") {
    const rows = lk.index.divisions.map((d) => ({ name: d, parent: "—", count: lk.index.districts.filter((x) => x.division === d).length }));
    return { text: `Bangladesh has **${rows.length} divisions** in the data.`, table: { columns: [{ key: "name", label: "Division", format: "text" }, { key: "count", label: "Districts", format: "int" }], rows }, suggestions: ["Top 10 districts by cases in the last 12 months", "Cases by division in 2025"] };
  }
  if (level === "district") {
    const ds = lk.index.districts.filter((d) => !sel || (sel.level === "division" ? d.division === sel.division : sel.level === "group" ? (sel.districts ?? []).includes(d.name) : d.name === sel.districts?.[0]));
    const rows = ds.map((d) => ({ name: d.name, parent: d.division, count: lk.index.upazilas.filter((u) => u.district === d.name).length }));
    return {
      text: `${sel ? `${sel.label} has` : "The data cover"} **${rows.length} ${pluralize(rows.length, "district")}**${sel ? ":" : "."} ${rows.length <= 14 ? joinList(rows.map((r) => r.name)) : ""}`.trim(),
      table: { columns: [{ key: "name", label: "District", format: "text" }, { key: "parent", label: "Division", format: "text" }, { key: "count", label: "Reporting upazilas", format: "int" }], rows },
      suggestions: [sel ? `Cases by district in ${shortName(sel)} in 2025` : "Top 10 districts by cases in the last 12 months", "Which upazilas have the most cases?"],
    };
  }
  const us = lk.index.upazilas.filter((u) => (sel ? (sel.level === "division" ? u.division === sel.division : sel.level === "group" ? (sel.districts ?? []).includes(u.district) : sel.level === "district" ? u.district === sel.districts?.[0] : sel.upazilaIds?.includes(u.id)) : true));
  const rows = us.map((u) => ({ name: u.name, parent: u.district, count: null as number | null })).sort((a, b) => a.parent.localeCompare(b.parent) || a.name.localeCompare(b.name));
  return {
    text: `${sel ? `${sel.label} has` : "The data have"} **${rows.length} reporting ${pluralize(rows.length, "upazila")}** (units that have submitted at least one MIS report)${rows.length > 60 ? "; showing the first 60" : ""}.`,
    table: { columns: [{ key: "name", label: "Upazila", format: "text" }, { key: "parent", label: "District", format: "text" }], rows: rows.slice(0, 60) },
    suggestions: [sel ? `Which upazilas in ${shortName(sel)} have the most cases?` : "Top 10 upazilas by cases in the last 12 months"],
  };
}

export async function meta(bounds: Bounds, lk: AreaLookup): Promise<Part> {
  const ov = await dataOverview();
  const wx = ov.weather_coverage as { districts: number; first_year: number; latest: number } | null;
  const fc = ov.forecasts as { target: string; model: string; accuracy_pct: number | null }[];
  let text = `## What I can see\n\n- **Surveillance data (NMEP MIS):** ${fmtN(bounds.rows)} upazila-month records, **${bounds.firstYear} to ${plabel(bounds.latestP)}** — ${lk.index.divisions.length} divisions, ${lk.index.districts.length} districts, ${fmtN(lk.index.upazilas.length)} reporting upazilas.\n`;
  text += `- **Last successful sync:** ${ov.last_successful_sync ? new Date(ov.last_successful_sync as unknown as string).toUTCString() : "no sync recorded"} (the dashboard refreshes daily from the live MIS).\n`;
  text += wx ? `- **Weather (ERA5):** ${wx.districts} districts from ${wx.first_year} to ${plabel(pOf(Math.floor(wx.latest / 100), wx.latest % 100))}.\n` : "- **Weather:** not loaded.\n";
  text += fc.length ? `- **Forecasts:** ${fc.map((f) => `${f.target} (${MODEL_LABEL[f.model] ?? f.model}${f.accuracy_pct != null ? `, ${fmtN(Number(f.accuracy_pct), 0)}% back-tested accuracy` : ""})`).join("; ")}.\n` : "- **Forecasts:** not generated yet.\n";
  text += `- **Population:** ${typeof ov.population === "string" ? "not imported" : "imported for the 77 at-risk upazilas (used for API/ABER)"}.\n\n`;
  text += "**Caveats worth knowing:** referral counts are rarely reported after 2014; active vs passive detection only exists from 2021; the number of reporting units jumped in 2018; and population exists only for the 77 at-risk upazilas.";
  return { text, suggestions: ["Give me a situation brief for Bangladesh", "Which month of the year has the most cases?", "What is test positivity?"] };
}

export function glossary(entry: (typeof GLOSSARY)[number]): Part {
  return {
    text: `## ${entry.term}\n\n${entry.text}`,
    suggestions: entry.term.includes("(TPR)") ? ["Test positivity by division in 2025", "Which districts have the highest test positivity?"]
      : entry.term.includes("(API)") ? ["API by district in 2025", "Compare API and ABER for Bandarban"]
      : entry.term.includes("(CFR)") ? ["Case fatality rate by division since 2018", "Which districts had deaths this year?"]
      : ["Give me a situation brief for Bangladesh", "What can you do?"],
  };
}

export function about(): Part {
  const examples = STARTERS.flatMap((s) => s.prompts.slice(0, 1));
  return {
    kind: "help",
    text: `## I'm the MIS Analyst\n\nI answer questions about Bangladesh's malaria surveillance data by **writing and running read-only database queries** for you, then explaining the result in plain language — with a table, a chart and the exact SQL I used. I'm free to use: I run on your own database and need no external AI service or key.\n\n**What I can do**\n\n${CAPABILITIES.map((c) => `- ${c}`).join("\n")}\n\n**What I won't do:** change data. I'm strictly **read-only** — every query runs in a read-only database transaction.\n\nJust ask in your own words; follow-ups like “and deaths?” or “what about Sylhet?” work too.`,
    suggestions: examples.slice(0, 5),
  };
}

export function greeting(): Part {
  return {
    kind: "help",
    text: "Hello! 👋 I'm the **MIS Analyst**. Ask me anything about malaria in Bangladesh — cases, deaths, trends, hotspots, comparisons, forecasts or weather links — and I'll query the database and show you the numbers.",
    suggestions: ["Give me a situation brief for Bangladesh", "Top 10 upazilas by cases in the last 12 months", "Any unusual rise in cases this month?"],
  };
}

export function thanks(): Part {
  return { kind: "help", text: "You're welcome! Ask me anything else — or try one of these.", suggestions: ["Which districts increased the most vs last year?", "Forecast cases for Bangladesh", "What can you do?"] };
}

export { monthOfP, yearOfP };
