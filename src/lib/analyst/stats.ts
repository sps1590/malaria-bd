/**
 * The workhorse intent: counts, rates, trends, rankings and comparisons over mis_monthly.
 * plan → run (read-only SQL) → present (narrative + table + chart + follow-up suggestions).
 */
import type { AreaSel } from "./areas";
import {
  AREA_GROUPS, BREAKDOWNS, DEFAULT_RANK, DEFAULT_SUMMARY, TIME_GROUPS, metricOf, type GroupKey, type MetricDef,
} from "./catalog";
import { cellFormat, chartFormat, fmtMetric, labelG, nounFor, sentence, unitWord } from "./format";
import type { Parsed } from "./nlu";
import { newLog, runAgg, type AggRow, type Op, type RunLog } from "./query";
import type { Bounds } from "./store";
import { arrowPct, cellPct, fmtN, joinList, pctChange, pluralize } from "./text";
import { labelRange, plabel, pOf, yearOfP } from "./time";
import type { Cell, ChartSpec, TableColumn, TableSpec } from "./types";

export interface StatsPlan {
  metrics: MetricDef[];
  primary: MetricDef;
  group: GroupKey;
  areas: AreaSel[];
  perArea: boolean;
  from: number;
  to: number;
  months?: number[];
  timeLabel: string;
  /** "Jun, Jul · " when a season or month filter applies, else "". */
  prefix: string;
  timeAssumed: boolean;
  having: { metric: MetricDef; op: Op; value: number; text: string; phrase: string }[];
  guards: { expr: string; min: number }[];
  rankDir: "asc" | "desc";
  rankExplicit: boolean;
  limit: number | null;
  /** Months to look back for the comparison window (null = no comparison). */
  shift: number | null;
  compareExplicit: boolean;
  direction: "up" | "down" | null;
  avgMonthly: boolean;
  breakdown: Parsed["breakdown"];
  peak: boolean;
  assumptions: string[];
  groupAssumed: boolean;
}

const DEPTH: Record<string, number> = { division: 1, district: 2, upazila: 3 };

function childLevel(scope: AreaSel | undefined): GroupKey | null {
  if (!scope) return "district";
  if (scope.level === "division" || scope.level === "group") return "district";
  if (scope.level === "district") return "upazila";
  return null;
}

const OP_WORDS: Record<Op, string> = { ">": "more than", ">=": "at least", "<": "fewer than", "<=": "at most", "=": "exactly" };

/** "had more than 100 confirmed cases" / "reported deaths" / "reported no deaths". */
function conditionPhrase(def: MetricDef, op: Op, value: number): string {
  const noun = sentence(def.label.replace(/ \(%\)$/, ""));
  if (value === 0 && (op === ">" || op === ">=")) return def.unit === "count" ? `reported ${noun}` : `had ${noun} above zero`;
  if (value === 0 && op === "=") return def.unit === "count" ? `reported no ${noun}` : `had ${noun} of zero`;
  const v = def.unit === "pct" ? `${fmtN(value, Number.isInteger(value) ? 0 : 2)}%` : fmtN(value, Number.isInteger(value) ? 0 : 2);
  return `had ${OP_WORDS[op]} ${v} ${noun}`;
}

export function planStats(p: Parsed, bounds: Bounds): StatsPlan {
  const assumptions: string[] = [];
  const latest = bounds.latestP;
  const areas = p.areas.slice(0, 6);
  const perArea = areas.length >= 2;
  const scope1 = areas.length === 1 ? areas[0] : undefined;

  // ---- grouping
  let group: GroupKey = p.group ?? p.groupLevel ?? "none";
  let groupAssumed = false;
  if (group === "none" && p.rank && !perArea && !p.peak) {
    const child = childLevel(scope1);
    if (child) { group = child; groupAssumed = true; }
  }
  if (AREA_GROUPS.includes(group) && scope1 && scope1.level !== "group") {
    // grouping at (or above) the level of the chosen area makes no sense — fall back to its children
    if (DEPTH[group] <= DEPTH[scope1.level]) {
      const child = childLevel(scope1);
      group = child ?? "none";
      if (child) groupAssumed = true;
    }
  }
  if (AREA_GROUPS.includes(group) && perArea) group = "none";

  // ---- period
  let from: number;
  let to: number;
  const months = p.time?.months;
  let timeAssumed = false;
  const explicitTime = !!p.time && p.time.from >= 0;
  if (explicitTime) {
    from = p.time!.from;
    to = p.time!.to;
  } else {
    timeAssumed = true;
    const allFrom = pOf(bounds.firstYear, 1);
    if (group === "year" || group === "calmonth") [from, to] = [allFrom, latest];
    else if (group === "month" || group === "quarter") [from, to] = [Math.max(allFrom, latest - (months?.length ? 35 : 23)), latest];
    else [from, to] = [latest - 11, latest];
    if (group === "none" || AREA_GROUPS.includes(group)) assumptions.push(`No period was given, so I used the **last 12 months** (${plabel(latest - 11)} – ${plabel(latest)}).`);
    else assumptions.push(`No period was given, so I used ${group === "year" || group === "calmonth" ? "**all years on record**" : "the **last 24 months**"}.`);
  }
  const len = to - from + 1;
  const monthsPrefix = months?.length && p.time ? `${p.time.label.includes(" · ") ? p.time.label.split(" · ")[0] : p.time.label} · ` : "";
  if (explicitTime && group === "none" && !p.rank && !perArea && !p.breakdown && len > 13 && !p.peak && p.compare?.kind !== "years" && p.agg !== "avg_monthly") {
    group = "year";
    groupAssumed = true;
    assumptions.push("The period spans several years, so I broke it down **by year**.");
  }
  if (group === "month" && p.trendOnly && len > 72) {
    group = "year";
    assumptions.push(`A monthly trend over ${Math.round(len / 12)} years is too long to read, so I showed **yearly** totals (ask for “monthly” to see every month).`);
  }
  if (explicitTime && group === "year" && len <= 12 && !p.group) {
    group = "month"; // a single year "by year" is a single bar; monthly is what was meant
    assumptions.push("A single year was requested, so I broke it down **by month**.");
  }

  // ---- metrics
  let keys: string[];
  if (p.breakdown) {
    keys = [...BREAKDOWNS[p.breakdown].metrics];
    if (p.breakdown === "age" || p.breakdown === "sex") assumptions.push("Age and sex are recorded for confirmed cases only (not for deaths or tests).");
  } else if (p.metrics.length) keys = [...new Set(p.metrics)];
  else if (TIME_GROUPS.includes(group)) keys = p.peak ? ["cases"] : ["cases", "deaths"];
  else if (AREA_GROUPS.includes(group)) keys = p.compare || p.direction ? ["cases"] : [...DEFAULT_RANK];
  else keys = [...DEFAULT_SUMMARY];
  keys = keys.slice(0, 8);
  const primaryKey = keys[0];

  const having = p.having
    .filter((h) => !h.soft || AREA_GROUPS.includes(group) || TIME_GROUPS.includes(group))
    .map((h) => {
      const key = h.metric ?? primaryKey;
      if (!keys.includes(key)) keys.push(key);
      const def = metricOf(key);
      return { metric: def, op: h.op, value: h.value, text: `${def.label} ${OP_WORDS[h.op]} ${fmtN(h.value, Number.isInteger(h.value) ? 0 : 2)}`, phrase: conditionPhrase(def, h.op, h.value) };
    });

  const metrics = keys.map(metricOf);
  const primary = metricOf(primaryKey);

  // rates from tiny denominators (1 case in 1 test = 100%) must not top a ranking
  const guards: StatsPlan["guards"] = [];
  if (AREA_GROUPS.includes(group) && primary.guard) {
    guards.push({ expr: primary.guard.expr, min: primary.guard.min });
    assumptions.push(`Areas with fewer than ${primary.guard.min} ${primary.guard.what} are left out of this ranking, because a rate from so few is unreliable.`);
  }

  // ---- ranking & limit
  const rankExplicit = !!p.rank;
  const rankDir = p.rank?.dir ?? "desc";
  let limit: number | null = null;
  if (AREA_GROUPS.includes(group)) limit = p.rank?.n ?? 10;
  else if (TIME_GROUPS.includes(group) && p.rank?.n) limit = p.rank.n;
  if (limit !== null) limit = Math.max(1, Math.min(limit, 200));

  // ---- comparison window
  let shift: number | null = null;
  const compareExplicit = !!p.compare;
  const kinds = p.compare?.kind;
  if (kinds) {
    shift = kinds === "yoy" ? 12 : kinds === "mom" ? (len === 1 ? 1 : len) : kinds === "prev" ? len : kinds === "years" ? (p.compare?.shift ?? 12) : len <= 12 ? 12 : len;
  } else if (group === "none" && !perArea && !p.breakdown && len <= 12) {
    shift = 12; // every single-period answer also states the same period a year earlier
  }
  if (TIME_GROUPS.includes(group)) shift = null; // trends carry their own change column
  if (shift !== null && from - shift < pOf(bounds.firstYear, 1)) {
    if (compareExplicit) assumptions.push("The comparison period starts before the data do, so there is nothing to compare with.");
    shift = null;
  }

  return {
    metrics, primary, group, areas, perArea, from, to, months, timeLabel: monthsPrefix + labelRange(from, to, latest), prefix: monthsPrefix, timeAssumed,
    having, guards, rankDir, rankExplicit, limit, shift, compareExplicit, direction: p.direction, avgMonthly: p.agg === "avg_monthly" && metrics.every((m) => m.inner),
    breakdown: p.breakdown, peak: p.peak, assumptions, groupAssumed,
  };
}

/* ------------------------------ run ------------------------------ */

export interface Bundle {
  scope: AreaSel[];
  cur: AggRow[];
  prev?: AggRow[];
  /** Same query one year earlier for the first 12 months of a monthly series (YoY column). */
  yoy?: AggRow[];
  /** Totals over the whole scope for share-of-total. */
  total?: AggRow;
  national?: AggRow;
}

const isAdditive = (m: MetricDef) => m.unit === "count" && !m.distinct;
const labelOf = (areas: AreaSel[]) => (areas.length === 0 ? "Bangladesh" : areas.length === 1 ? areas[0].label : joinList(areas.map((a) => a.label)));

export async function runStats(plan: StatsPlan, log: RunLog): Promise<Bundle[]> {
  const base = {
    metrics: plan.metrics, months: plan.months, avgMonthly: plan.avgMonthly,
  };
  const scopes: AreaSel[][] = plan.perArea ? plan.areas.map((a) => [a]) : [plan.areas];

  const one = async (scope: AreaSel[]): Promise<Bundle> => {
    const areaGroup = AREA_GROUPS.includes(plan.group);
    const timeGroup = TIME_GROUPS.includes(plan.group);
    const needAllRows = areaGroup && (plan.shift !== null || plan.direction !== null || plan.having.length > 0);
    const sqlHaving = plan.having.map(({ metric, op, value }) => ({ metric, op, value }));
    const cur = await runAgg(
      {
        ...base, group: plan.group, areas: scope, from: plan.from, to: plan.to, having: sqlHaving, guards: plan.guards,
        order: areaGroup ? { by: plan.primary, dir: plan.rankDir } : timeGroup && plan.limit ? { by: plan.primary, dir: plan.rankDir } : undefined,
        limit: needAllRows ? undefined : plan.limit ?? undefined,
      },
      log,
      areaGroup ? `Rank by ${plan.primary.label}` : timeGroup ? `${plan.primary.label} by ${unitWord(plan.group)}` : "Totals for the period",
    );
    const bundle: Bundle = { scope, cur };

    if (plan.shift !== null && !timeGroup) {
      bundle.prev = await runAgg(
        { ...base, group: plan.group, areas: scope, from: plan.from - plan.shift, to: plan.to - plan.shift, having: [], limit: undefined },
        log,
        `Comparison period (${labelRange(plan.from - plan.shift, plan.to - plan.shift, plan.to)})`,
      );
    }
    if (plan.group === "month") {
      // YoY column for the first 12 months needs the year before
      bundle.yoy = await runAgg(
        { ...base, metrics: [plan.primary], group: "month", areas: scope, from: plan.from - 12, to: Math.min(plan.to - 12, plan.from + 11), having: [] },
        log,
        "Same months one year earlier (for the year-on-year column)",
      );
    }
    if (areaGroup && isAdditive(plan.primary)) {
      const [total] = await runAgg({ ...base, metrics: [plan.primary], group: "none", areas: scope, from: plan.from, to: plan.to, having: [] }, log, "Total across all areas (for % share)");
      bundle.total = total;
    }
    if (plan.group === "none" && scope.length > 0 && isAdditive(plan.primary)) {
      const [national] = await runAgg({ ...base, metrics: [plan.primary], group: "none", areas: [], from: plan.from, to: plan.to, having: [] }, log, "National total for the same period");
      bundle.national = national;
    }
    return bundle;
  };
  return Promise.all(scopes.map(one));
}

/* ------------------------------ present ------------------------------ */

export interface Presentation {
  text: string;
  table?: TableSpec;
  chart?: ChartSpec;
  suggestions: string[];
  empty: boolean;
}

const num = (row: AggRow | undefined, key: string): number | null => {
  const v = row?.[key];
  return typeof v === "number" ? v : null;
};
const allNull = (row: AggRow | undefined, plan: StatsPlan) => !row || plan.metrics.every((m) => num(row, m.key) === null);

function sumVal(rows: AggRow[], key: string): number {
  return rows.reduce((s, r) => s + (num(r, key) ?? 0), 0);
}

export function presentStats(plan: StatsPlan, bundles: Bundle[], p: Parsed, latestP: number): Presentation {
  if (plan.perArea) return presentPerArea(plan, bundles, latestP);
  const b = bundles[0];
  if (AREA_GROUPS.includes(plan.group)) return presentRanking(plan, b, latestP);
  if (TIME_GROUPS.includes(plan.group)) return presentSeries(plan, b, latestP);
  return presentScalar(plan, b, p, latestP);
}

const scopeName = (b: Bundle) => labelOf(b.scope);

function withNotes(text: string, plan: StatsPlan): string {
  const notes = [...plan.assumptions];
  for (const m of plan.metrics) if (m.caveat && !notes.includes(m.caveat)) notes.push(m.caveat);
  return notes.length ? `${text}\n\n${notes.map((n) => `_${n.replace(/\*\*/g, "")}_`).join("\n")}` : text;
}

/* ---- scalar (group none) ---- */

function presentScalar(plan: StatsPlan, b: Bundle, p: Parsed, latestP: number): Presentation {
  const row = b.cur[0];
  const name = scopeName(b);
  const prevLabel = plan.shift !== null ? plan.prefix + labelRange(plan.from - plan.shift, plan.to - plan.shift, latestP) : null;
  if (allNull(row, plan) || (plan.having.length && !b.cur.length)) {
    const cond = plan.having.length ? ` that meet “${plan.having.map((h) => h.text).join(" and ")}”` : "";
    return {
      text: withNotes(`No reports${cond} were found for **${name}** in ${plan.timeLabel}. ${plan.having.length ? "Try relaxing the condition or widening the period." : "Either nothing was reported or the period is outside the data."}`, plan),
      suggestions: [`Cases in ${name === "Bangladesh" ? "Bangladesh" : name} over the last 12 months`, "What data period do you have?"],
      empty: true,
    };
  }

  const phrase = (m: MetricDef) => {
    const v = num(row, m.key);
    if (m.unit === "count") return `**${fmtMetric(m, v)}** ${nounFor(m, v)}`;
    const name = sentence(m.label.replace(/ \(.*\)$/, ""));
    return `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name} of **${fmtMetric(m, v)}**`;
  };
  const first = plan.metrics.slice(0, 2).map(phrase);
  const verb = plan.avgMonthly ? "averaged" : "recorded";
  const per = plan.avgMonthly ? " per month" : "";
  let text = `**${name}** ${verb} ${joinList(first)}${per} in ${plan.timeLabel}.`;
  const lines: string[] = [];

  if (plan.shift !== null && b.prev) {
    const prow = b.prev[0];
    const pm = plan.metrics.filter((m) => num(prow, m.key) !== null && num(row, m.key) !== null).slice(0, 3);
    for (const m of pm) {
      const cur = num(row, m.key)!;
      const prv = num(prow, m.key)!;
      const ch = m.unit === "count" ? pctChange(cur, prv) : null;
      lines.push(
        m.unit === "count"
          ? `- **${m.label}**: ${fmtMetric(m, cur)} vs ${fmtMetric(m, prv)} in ${prevLabel} — ${arrowPct(ch)}`
          : `- **${m.label}**: ${fmtMetric(m, cur)} vs ${fmtMetric(m, prv)} in ${prevLabel} (${cur - prv >= 0 ? "+" : "−"}${fmtN(Math.abs(cur - prv), m.decimals)} points)`,
      );
    }
  }
  if (b.national && plan.areas.length && isAdditive(plan.primary)) {
    const share = num(b.cur[0], plan.primary.key) !== null && num(b.national, plan.primary.key) ? (num(b.cur[0], plan.primary.key)! / num(b.national, plan.primary.key)!) * 100 : null;
    if (share !== null && num(b.cur[0], plan.primary.key)) lines.push(`- ${name} accounts for **${fmtN(share, share < 10 ? 1 : 0)}%** of Bangladesh's ${sentence(plan.primary.label)} in this period (${fmtN(num(b.national, plan.primary.key), 0)}).`);
  }
  const tpr = num(row, "tpr");
  if (tpr !== null && tpr > 0) {
    lines.push(tpr >= 10 ? `- Test positivity is high (${fmtN(tpr, 1)}%): transmission is intense or only the sickest are being tested.` : tpr < 1 ? `- Test positivity is very low (${fmtN(tpr, 2)}%), consistent with low transmission.` : "");
  }
  if (lines.filter(Boolean).length) text += `\n\n${lines.filter(Boolean).join("\n")}`;

  // table: current / previous / change as rows, metrics as columns
  const columns = [{ key: "period", label: "Period", format: "text" as const }, ...plan.metrics.map((m) => ({ key: m.key, label: m.label, format: cellFormat(m) }))];
  const rows: Record<string, Cell>[] = [{ period: plan.timeLabel, ...Object.fromEntries(plan.metrics.map((m) => [m.key, num(row, m.key)])) }];
  if (plan.shift !== null && b.prev?.[0]) {
    rows.push({ period: prevLabel!, ...Object.fromEntries(plan.metrics.map((m) => [m.key, num(b.prev![0], m.key)])) });
    rows.push({
      period: "Change",
      ...Object.fromEntries(plan.metrics.map((m) => {
        const cur = num(row, m.key), prv = num(b.prev![0], m.key);
        if (cur === null || prv === null) return [m.key, "—"];
        return [m.key, m.unit === "count" ? arrowPct(pctChange(cur, prv)) : `${cur - prv >= 0 ? "+" : "−"}${fmtN(Math.abs(cur - prv), m.decimals)} pts`];
      })),
    });
  }

  // chart: a breakdown (species / age / sex) is shown as bars
  let chart: ChartSpec | undefined;
  let tableOut: TableSpec = { columns, rows };
  if (plan.breakdown) {
    const grand = plan.metrics.reduce((sum, m) => sum + (num(row, m.key) ?? 0), 0);
    tableOut = {
      columns: [
        { key: "group", label: BREAKDOWNS[plan.breakdown].label[0].toUpperCase() + BREAKDOWNS[plan.breakdown].label.slice(1), format: "text" },
        { key: "value", label: "Cases", format: "int" },
        { key: "share", label: "Share of classified cases", format: "pct1" },
        ...(plan.shift !== null && b.prev?.[0] ? [{ key: "prev", label: `Cases — ${prevLabel}`, format: "int" as const }, { key: "chg", label: "Change", format: "signed_pct" as const }] : []),
      ],
      rows: plan.metrics.map((m) => ({
        group: m.label,
        value: num(row, m.key),
        share: grand > 0 && num(row, m.key) !== null ? (num(row, m.key)! / grand) * 100 : null,
        ...(plan.shift !== null && b.prev?.[0] ? { prev: num(b.prev[0], m.key), chg: cellPct(pctChange(num(row, m.key), num(b.prev[0], m.key))) } : {}),
      })),
    };
    const total = plan.metrics.reduce((s, m) => s + (num(row, m.key) ?? 0), 0);
    chart = {
      kind: "bar", title: `${BREAKDOWNS[plan.breakdown].label[0].toUpperCase()}${BREAKDOWNS[plan.breakdown].label.slice(1)} breakdown — ${name}, ${plan.timeLabel}`, xKey: "label",
      series: [{ key: "value", label: "Cases" }], format: "int",
      rows: plan.metrics.map((m) => ({ label: m.label, value: num(row, m.key) })),
    };
    if (total > 0) {
      const top = [...plan.metrics].sort((a, c) => (num(row, c.key) ?? 0) - (num(row, a.key) ?? 0))[0];
      text += `\n\nThe largest group is **${top.label}** with **${fmtN(((num(row, top.key) ?? 0) / total) * 100, 0)}%** of the ${fmtN(total)} classified cases.`;
    }
  }

  const sg = name === "Bangladesh" ? [] : [`Show the monthly trend for ${name}`];
  return {
    text: withNotes(text, plan),
    table: tableOut,
    chart,
    suggestions: [
      ...sg,
      ...(plan.areas.length === 1 && plan.areas[0].level !== "upazila" ? [`Which ${plan.areas[0].level === "division" ? "districts" : "upazilas"} in ${plan.areas[0].label.replace(/ (division|district)$/, "")} have the most cases?`] : ["Which districts have the most cases?"]),
      "Why did cases change compared to last year?",
    ].slice(0, 3),
    empty: false,
  };
}

/* ---- per-area comparison ---- */

function presentPerArea(plan: StatsPlan, bundles: Bundle[], latestP: number): Presentation {
  const names = bundles.map((b) => scopeName(b));
  const timeGroup = TIME_GROUPS.includes(plan.group);

  if (timeGroup) {
    // wide: one column per area for the primary metric
    const keys = new Map<number, Record<string, Cell>>();
    bundles.forEach((b, i) => {
      for (const r of b.cur) {
        const g = Number(r.g);
        const row = keys.get(g) ?? { g: labelG(plan.group, g), _o: g };
        row[`a${i}`] = num(r, plan.primary.key);
        keys.set(g, row);
      }
    });
    const rows = [...keys.values()].sort((a, c) => Number(a._o) - Number(c._o));
    const series = names.map((n, i) => ({ key: `a${i}`, label: n }));
    const totals = bundles.map((b) => (isAdditive(plan.primary) ? sumVal(b.cur, plan.primary.key) : null));
    const lead = isAdditive(plan.primary)
      ? `**${plan.primary.label}** by ${unitWord(plan.group)}, ${plan.timeLabel}: ${joinList(names.map((n, i) => `**${n}** ${fmtN(totals[i], 0)}`))} in total.`
      : `**${plan.primary.label}** by ${unitWord(plan.group)}, ${plan.timeLabel}, for ${joinList(names)}.`;
    return {
      text: withNotes(lead, plan),
      table: { columns: [{ key: "g", label: "Period", format: "text" }, ...series.map((s) => ({ key: s.key, label: s.label, format: cellFormat(plan.primary) }))], rows: rows.map(({ _o, ...rest }) => { void _o; return rest; }) },
      chart: { kind: plan.group === "month" ? "line" : "bar", title: `${plan.primary.label} — ${joinList(names)}`, xKey: "g", series, rows: rows.map(({ _o, ...rest }) => { void _o; return rest; }), format: chartFormat(plan.primary) },
      suggestions: [`Which of them has more ${sentence(plan.primary.label)} in the last 12 months?`, "Why did cases change compared to last year?"],
      empty: false,
    };
  }

  const rows: Record<string, Cell>[] = bundles.map((b, i) => ({
    area: names[i],
    ...Object.fromEntries(plan.metrics.map((m) => [m.key, num(b.cur[0], m.key)])),
  }));
  const ranked = [...rows].sort((a, c) => (Number(c[plan.primary.key]) || 0) - (Number(a[plan.primary.key]) || 0));
  const hi = ranked[0], lo = ranked[ranked.length - 1];
  const hv = Number(hi[plan.primary.key]), lv = Number(lo[plan.primary.key]);
  let text = `Comparing ${joinList(names)} for ${plan.timeLabel}, on **${plan.primary.label}**: **${hi.area}** is highest (**${fmtMetric(plan.primary, hv)}**)`;
  text += ranked.length === 2 && lv > 0 && isAdditive(plan.primary) ? `, ${fmtN(hv / lv, 1)}× ${lo.area} (${fmtMetric(plan.primary, lv)}).` : `; **${lo.area}** is lowest (${fmtMetric(plan.primary, lv)}).`;
  if (plan.metrics.length > 1) {
    const other = plan.metrics.find((m) => m.key === "tpr") ?? plan.metrics[1];
    const oh = [...rows].sort((a, c) => (Number(c[other.key]) || 0) - (Number(a[other.key]) || 0))[0];
    if (oh.area !== hi.area || other.key === "tpr") text += ` On ${other.label.toLowerCase()}, **${oh.area}** leads with ${fmtMetric(other, Number(oh[other.key]))}.`;
  }
  void latestP;
  return {
    text: withNotes(text, plan),
    table: { columns: [{ key: "area", label: "Area", format: "text" }, ...plan.metrics.map((m) => ({ key: m.key, label: m.label, format: cellFormat(m) }))], rows },
    chart: { kind: "bar", title: `${plan.primary.label} — ${plan.timeLabel}`, xKey: "area", series: [{ key: plan.primary.key, label: plan.primary.label }], rows, format: chartFormat(plan.primary) },
    suggestions: [`Monthly trend for ${hi.area}, ${plan.timeLabel.includes("last") ? "last 24 months" : plan.timeLabel}`, `Why did cases change in ${hi.area} compared to last year?`],
    empty: false,
  };
}

/* ---- ranking by area ---- */

function presentRanking(plan: StatsPlan, b: Bundle, latestP: number): Presentation {
  const level = plan.group;
  const levelWord = level === "upazila" ? "upazilas" : level === "district" ? "districts" : "divisions";
  const scope = b.scope.length ? scopeName(b) : "Bangladesh";
  const prevByG = new Map((b.prev ?? []).map((r) => [String(r.g), r]));
  const prevLabel = plan.shift !== null ? plan.prefix + labelRange(plan.from - plan.shift, plan.to - plan.shift, latestP) : null;

  let rows = b.cur.map((r) => {
    const prev = prevByG.get(String(r.g));
    const cur = num(r, plan.primary.key);
    const prv = num(prev, plan.primary.key);
    return { r, cur, prv, change: cur !== null && prv !== null ? cur - prv : null, pct: pctChange(cur, prv) };
  });

  // comparison-driven questions: apply HAVING in JS and order by change
  const wantChange = plan.shift !== null && (plan.direction !== null || plan.compareExplicit);
  if (wantChange) {
    const dir = plan.direction === "down" ? 1 : -1;
    rows = rows.filter((x) => x.change !== null && (plan.direction === "up" ? x.change > 0 : plan.direction === "down" ? x.change < 0 : true));
    rows.sort((a, c) => (plan.direction ? dir * ((a.change ?? 0) - (c.change ?? 0)) : Math.abs(c.change ?? 0) - Math.abs(a.change ?? 0)));
  }
  const matched = rows.length;
  rows = rows.slice(0, plan.limit ?? 10);

  // upazila names carry their district ("Teknaf (Cox's Bazar)") — redundant when the scope is one district
  const shortNames = level === "upazila" && b.scope.length === 1 && b.scope[0].level === "district";
  const nm = (g: string | number | null) => (shortNames ? labelG(level, g).replace(/ \(.*\)$/, "") : labelG(level, g));
  const condition = plan.having.map((h) => h.phrase).join(" and ");

  if (!rows.length) {
    const why = plan.having.length ? ` ${condition}` : plan.direction ? ` with a ${plan.direction === "up" ? "rise" : "fall"} in ${sentence(plan.primary.label)}` : "";
    return { text: withNotes(`No ${levelWord}${why} were found in ${scope} for ${plan.timeLabel}.`, plan), suggestions: ["Show the top 10 districts by cases", "What data period do you have?"], empty: true };
  }

  const totalPrimary = num(b.total, plan.primary.key);
  const columns: TableColumn[] = [
    { key: "rank", label: "#", format: "int" },
    { key: "area", label: level[0].toUpperCase() + level.slice(1), format: "text" },
    ...plan.metrics.map((m) => ({ key: m.key, label: m.label, format: cellFormat(m) })),
  ];
  if (totalPrimary) columns.push({ key: "share", label: `% of ${scope === "Bangladesh" ? "national" : "total"} ${sentence(plan.primary.label)}`, format: "pct1" });
  if (plan.shift !== null) {
    columns.push({ key: "prev", label: `${plan.primary.label} — ${prevLabel}`, format: cellFormat(plan.primary) });
    columns.push({ key: "chg", label: "Change", format: "signed_pct" });
  }
  const tableRows: Record<string, Cell>[] = rows.map((x, i) => ({
    rank: i + 1,
    area: nm(x.r.g),
    ...Object.fromEntries(plan.metrics.map((m) => [m.key, num(x.r, m.key)])),
    ...(totalPrimary ? { share: x.cur !== null ? (x.cur / totalPrimary) * 100 : null } : {}),
    ...(plan.shift !== null ? { prev: x.prv, chg: cellPct(x.pct) } : {}),
  }));

  // narrative
  const top = rows[0];
  const topName = nm(top.r.g);
  const dirWord = plan.rankDir === "asc" ? "lowest" : "highest";
  const listed = (n: number) => {
    const items = rows.slice(0, n).map((x) => `${nm(x.r.g)} (${fmtMetric(plan.primary, x.cur)})`);
    const left = matched - items.length;
    return left > 0 ? `${items.join(", ")} and ${left} more` : joinList(items);
  };
  const more = matched > rows.length;
  const allZero = rows.every((x) => !x.cur);
  let text: string;
  if (allZero && !wantChange && !plan.having.length) {
    const noun = sentence(plan.primary.label);
    text = plan.rankDir === "asc"
      ? `Many ${levelWord} in ${scope} tie at **0** ${noun} in ${plan.timeLabel} — for example ${joinList(rows.slice(0, 3).map((x) => nm(x.r.g)))}.`
      : `**No ${noun}** were recorded in any of the ${b.cur.length} ${levelWord} of ${scope} in ${plan.timeLabel}.`;
  } else if (wantChange) {
    const verb = plan.direction === "down" ? "fell" : plan.direction === "up" ? "rose" : "changed";
    text = `**${matched} ${pluralize(matched, level, levelWord)}** in ${scope} ${verb} on ${sentence(plan.primary.label)} (${plan.timeLabel} vs ${prevLabel}). The largest ${plan.direction === "down" ? "fall" : plan.direction === "up" ? "rise" : "change"} is **${topName}**: ${fmtMetric(plan.primary, top.cur)} vs ${fmtMetric(plan.primary, top.prv)} (${arrowPct(top.pct)}).`;
  } else if (plan.having.length) {
    text = `**${matched} ${pluralize(matched, level, levelWord)}** in ${scope} ${condition} in ${plan.timeLabel}: ${listed(5)}.`;
  } else {
    text = `In ${scope}, **${topName}** has the ${dirWord} ${sentence(plan.primary.label)} in ${plan.timeLabel}: **${fmtMetric(plan.primary, top.cur)}**`;
    if (totalPrimary && top.cur !== null) text += ` (${fmtN((top.cur / totalPrimary) * 100, 0)}% of the total)`;
    if (rows.length > 1) text += `, ahead of ${joinList(rows.slice(1, 3).map((x) => `${nm(x.r.g)} (${fmtMetric(plan.primary, x.cur)})`))}`;
    text += ".";
  }
  if (totalPrimary && rows.length >= 3 && !wantChange && !allZero && !plan.having.length && plan.rankDir === "desc" && (more || b.cur.length === plan.limit)) {
    const share = rows.reduce((s, x) => s + (x.cur ?? 0), 0) / totalPrimary;
    text += ` ${plan.rankDir === "desc" ? "The top" : "These"} ${rows.length} together account for **${fmtN(share * 100, 0)}%** of the ${scope === "Bangladesh" ? "national" : "area"} total.`;
  }
  if (more) text += ` Showing ${rows.length} of ${matched}.`;

  const chart: ChartSpec = {
    kind: "hbar", title: `${plan.primary.label} by ${level} — ${scope}, ${plan.timeLabel}`, xKey: "area",
    series: [{ key: wantChange ? "chg2" : plan.primary.key, label: wantChange ? `${plan.primary.label} change` : plan.primary.label }],
    rows: tableRows.map((r, i) => ({ area: r.area, [plan.primary.key]: r[plan.primary.key], chg2: wantChange ? rows[i].change : null })),
    format: wantChange ? "int" : chartFormat(plan.primary),
  };

  const sg: string[] = [`Monthly trend for ${topName}`];
  if (rows.length > 1) sg.push(`Compare ${topName} and ${nm(rows[1].r.g)}`);
  sg.push(plan.shift === null ? "How does this compare with last year?" : "Show the same for deaths");
  return { text: withNotes(text, plan), table: { columns, rows: tableRows }, chart, suggestions: sg, empty: false };
}

/* ---- time series ---- */

function presentSeries(plan: StatsPlan, b: Bundle, latestP: number): Presentation {
  const name = scopeName(b);
  const unit = unitWord(plan.group);
  let rows = b.cur.filter((r) => r.g !== null);
  if (plan.group === "month" || plan.group === "year" || plan.group === "quarter") rows = [...rows].sort((a, c) => Number(a.g) - Number(c.g));
  if (plan.group === "calmonth") rows = [...rows].sort((a, c) => Number(a.g) - Number(c.g));
  if (!rows.length) {
    return { text: withNotes(`No reports were found for **${name}** in ${plan.timeLabel}.`, plan), suggestions: ["What data period do you have?"], empty: true };
  }
  const P = plan.primary;
  const pv = (r: AggRow) => num(r, P.key);
  const vals = rows.map(pv);
  const present = rows.filter((r) => pv(r) !== null);
  const peak = [...present].sort((a, c) => pv(c)! - pv(a)!)[0];
  const low = [...present].sort((a, c) => pv(a)! - pv(c)!)[0];
  const additive = isAdditive(P);
  const total = additive ? vals.reduce<number>((s, v) => s + (v ?? 0), 0) : null;

  // change column
  const yoyByG = new Map((b.yoy ?? []).map((r) => [Number(r.g), r]));
  const monthMap = new Map(rows.map((r) => [Number(r.g), r]));
  const change = (r: AggRow, i: number): number | null => {
    if (!P.inner && P.unit !== "pct" && P.unit !== "rate") return null;
    const cur = pv(r);
    if (plan.group === "year") return i > 0 ? pctChange(cur, pv(rows[i - 1])) : null;
    if (plan.group === "quarter") return i > 0 ? pctChange(cur, pv(rows[i - 1])) : null;
    if (plan.group === "month") {
      const g = Number(r.g);
      const prior = (monthMap.get(g - 100) ?? yoyByG.get(g - 100)) as AggRow | undefined;
      return pctChange(cur, num(prior, P.key));
    }
    return null;
  };
  const showChange = plan.group !== "calmonth" && P.unit === "count";

  const columns: TableColumn[] = [
    { key: "g", label: plan.group === "calmonth" ? "Month" : plan.group[0].toUpperCase() + plan.group.slice(1), format: "text" },
    ...plan.metrics.map((m) => ({ key: m.key, label: m.label, format: cellFormat(m) })),
  ];
  if (showChange) columns.push({ key: "chg", label: plan.group === "month" ? `${P.label}: vs same month last year` : `${P.label}: vs previous ${unit}`, format: "signed_pct" });
  const tableRows: Record<string, Cell>[] = rows.map((r, i) => ({
    g: labelG(plan.group, r.g),
    ...Object.fromEntries(plan.metrics.map((m) => [m.key, num(r, m.key)])),
    ...(showChange ? { chg: cellPct(change(r, i)) } : {}),
  }));
  const limitedRows = plan.limit && plan.limit < rows.length;

  // narrative
  let text = "";
  const pl = (n: number) => `${n} ${n === 1 ? unit : unit + "s"}`;
  if (plan.avgMonthly && additive) {
    text = `**Average monthly ${sentence(P.label)}** in **${name}** by ${unit}, ${plan.timeLabel}: from **${fmtMetric(P, pv(low))}** (${labelG(plan.group, low.g)}) to **${fmtMetric(P, pv(peak))}** (${labelG(plan.group, peak.g)}) a month.`;
  } else if (additive && total !== null) {
    const avg = total / Math.max(1, present.length);
    text = `**${P.label}** in **${name}**, ${plan.timeLabel}: **${fmtN(total)}** in total across ${pl(present.length)} (average **${fmtN(avg, avg < 10 ? 1 : 0)}** per ${unit}).`;
  } else {
    const mean = vals.reduce<number>((s, v) => s + (v ?? 0), 0) / Math.max(1, present.length);
    text = `**${P.label}** in **${name}**, ${plan.timeLabel}: ranging from ${fmtMetric(P, pv(low))} to ${fmtMetric(P, pv(peak))} across ${pl(present.length)} (mean ${fmtMetric(P, mean)}).`;
  }
  if (plan.metrics.length > 1 && plan.metrics.every((m) => m.unit === "count" && !m.distinct)) {
    const totals = plan.metrics.slice(0, 4).map((m) => `${m.label} **${fmtN(rows.reduce((sum, r) => sum + (num(r, m.key) ?? 0), 0))}**`);
    text += `

Totals over the period: ${joinList(totals)}. (Highlights below are for **${P.label}**.)`;
  }
  if (plan.peak && peak && additive) {
    const asc = plan.rankDir === "asc";
    const pick = asc ? low : peak;
    text = `The **${asc ? "lowest" : "highest"} ${unit}** for ${sentence(P.label)} in ${name} (${plan.timeLabel}) was **${labelG(plan.group, pick.g)}** with **${fmtMetric(P, pv(pick))}**.\n\n${text}`;
  }
  if (peak && low && peak !== low) text += `\n\n- **Highest ${unit}:** ${labelG(plan.group, peak.g)} — ${fmtMetric(P, pv(peak))}${additive && total ? ` (${fmtN((pv(peak)! / total) * 100, 0)}% of the total)` : ""}\n- **Lowest ${unit}:** ${labelG(plan.group, low.g)} — ${fmtMetric(P, pv(low))}`;
  if (plan.group === "calmonth" && additive && total && present.length >= 6) {
    const top3 = [...present].sort((a, c) => pv(c)! - pv(a)!).slice(0, 3);
    text += `\n- **Seasonal peak:** ${joinList(top3.map((r) => labelG("calmonth", r.g)))} — together ${fmtN((top3.reduce((s, r) => s + pv(r)!, 0) / total) * 100, 0)}% of all ${sentence(P.label)} across the years.`;
  }
  if (rows.length >= 6 && plan.group !== "calmonth" && additive) {
    const last = rows.slice(-3).map((r) => pv(r) ?? 0), before = rows.slice(-6, -3).map((r) => pv(r) ?? 0);
    const a = last.reduce((s, v) => s + v, 0) / 3, bAvg = before.reduce((s, v) => s + v, 0) / 3;
    const ch = pctChange(a, bAvg);
    if (ch !== null) text += `\n- **Recent direction:** the last 3 ${unit}s averaged ${fmtN(a, a < 10 ? 1 : 0)} vs ${fmtN(bAvg, bAvg < 10 ? 1 : 0)} in the 3 before (${arrowPct(ch)}).`;
  }
  if (plan.group === "month") {
    const lastRow = rows[rows.length - 1];
    const ch = change(lastRow, rows.length - 1);
    if (ch !== null && additive) text += `\n- **Latest month (${labelG("month", lastRow.g)}):** ${fmtMetric(P, pv(lastRow))}, ${arrowPct(ch)} vs the same month a year earlier.`;
  }
  if (plan.group === "year" && rows.length >= 3 && additive) {
    const lastRow = rows[rows.length - 1];
    const partial = lastRow.g === yearOfP(latestP) && (latestP % 12) + 1 < 12;
    if (partial) text += `\n- ${lastRow.g} is **incomplete** — data run to ${plabel(latestP)}, so the latest year is not directly comparable with full years.`;
  }
  if (limitedRows) text += `\n\nShowing the ${plan.limit} ${unit}s with the ${plan.rankDir === "asc" ? "lowest" : "highest"} ${sentence(P.label)}.`;

  // chart: first metric plus others of the same unit within one order of magnitude
  const maxOf = (m: MetricDef) => Math.max(...rows.map((r) => num(r, m.key) ?? 0), 0);
  const chartMetrics = plan.metrics.filter((m, i) => i === 0 || (m.unit === P.unit && maxOf(m) >= maxOf(P) / 10)).slice(0, 3);
  const chart: ChartSpec = {
    kind: plan.group === "month" || (plan.group === "year" && rows.length > 12) ? "line" : "bar",
    title: `${chartMetrics.map((m) => m.label).join(" & ")} by ${unit} — ${name}, ${plan.timeLabel}`,
    xKey: "g", series: chartMetrics.map((m) => ({ key: m.key, label: m.label })),
    rows: tableRows.map((r) => ({ g: r.g, ...Object.fromEntries(chartMetrics.map((m) => [m.key, r[m.key]])) })),
    format: chartFormat(P),
  };
  if (plan.limit) { chart.rows = [...chart.rows]; }

  const dropped = plan.metrics.length > chartMetrics.length;
  if (dropped) text += `\n\n_The chart shows ${joinList(chartMetrics.map((m) => m.label))} only — the other measures are on a very different scale (see the table)._`;

  const sg: string[] = [];
  if (b.scope.length) sg.push(`Which ${b.scope[0].level === "district" ? "upazilas" : "districts"} drove this?`);
  else sg.push("Which districts have the most cases?");
  sg.push(plan.group === "calmonth" ? "Show the yearly trend since 2018" : "Which month of the year has the most cases?");
  sg.push(`Forecast ${P.key === "deaths" ? "deaths" : "cases"} for ${b.scope.length ? b.scope[0].label.replace(/ (division|district)$/, "") : "Bangladesh"}`);
  return { text: withNotes(text, plan), table: { columns, rows: tableRows }, chart, suggestions: sg.slice(0, 3), empty: false };
}

export { newLog };
