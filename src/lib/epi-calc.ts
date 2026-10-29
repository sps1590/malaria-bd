/**
 * Pure epidemiological calculations behind the Epidemiology tab: continuous monthly series, endemic
 * channel, seasonality, aberration (outbreak-signal) detection, area league tables, case concentration,
 * API risk strata and elimination-progress measures. Everything works on the in-browser MIS records,
 * so it is isomorphic and free of side effects.
 */

import { MONTHS, addRecord, emptyTotals, groupTotals, measureValue, percentOf, type MisRecord, type Totals } from "./malaria-metrics";

/* --------------------------------- Time ---------------------------------- */

/** Month index on a single number line: year × 12 + (month − 1). */
export const recT = (r: Pick<MisRecord, "year" | "month">) => r.year * 12 + r.month - 1;
export const yearOf = (t: number) => Math.floor(t / 12);
export const monthShort = (t: number) => MONTHS[((t % 12) + 12) % 12].slice(0, 3);
export const periodLabel = (t: number) => `${monthShort(t)} ${yearOf(t)}`;

export interface MonthPoint {
  t: number;
  year: number;
  month: number;
  label: string;
  totals: Totals;
}

/** One point per calendar month from the first reported month to `latest` (silent months are zero-filled). */
export function monthlySeries(records: readonly MisRecord[], latest: number): MonthPoint[] {
  const byT = groupTotals(records, recT);
  if (!byT.size) return [];
  let first = Infinity;
  for (const t of byT.keys()) if (t < first) first = t;
  const out: MonthPoint[] = [];
  for (let t = first; t <= latest; t++) out.push({ t, year: yearOf(t), month: (t % 12) + 1, label: periodLabel(t), totals: byT.get(t) ?? emptyTotals() });
  return out;
}

/** Totals for records whose age (months before `latest`) is in [fromAge, toAge). */
export function windowTotals(records: readonly MisRecord[], latest: number, fromAge: number, toAge: number): Totals {
  const t = emptyTotals();
  for (const r of records) {
    const age = latest - recT(r);
    if (age >= fromAge && age < toAge) addRecord(t, r);
  }
  return t;
}

export interface YearRow {
  year: number;
  totals: Totals;
  /** Distinct months with at least one report — below 12 means a partial year. */
  months: number;
}

export function yearlyRows(records: readonly MisRecord[]): YearRow[] {
  const byYear = groupTotals(records, (r) => r.year);
  const months = new Map<number, Set<number>>();
  for (const r of records) {
    let s = months.get(r.year);
    if (!s) months.set(r.year, (s = new Set()));
    s.add(r.month);
  }
  return [...byYear].sort((a, b) => a[0] - b[0]).map(([year, totals]) => ({ year, totals, months: months.get(year)?.size ?? 0 }));
}

/* ------------------------------- Statistics ------------------------------- */

export const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);
export function sampleSd(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}
export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
}
export const pctChange = (now: number, before: number): number | null => (before > 0 ? ((now - before) / before) * 100 : null);

export function movingAverage(values: number[], window: number): (number | null)[] {
  return values.map((_, i) => (i + 1 < window ? null : mean(values.slice(i + 1 - window, i + 1))));
}

/* ---------------------------- Endemic channel ----------------------------- */

export interface ChannelMonth {
  month: number;
  label: string;
  q1: number;
  median: number;
  q3: number;
  threshold: number;
  current: number | null;
  previous: number;
  /** Mean cases of the same month over the cumulative-comparison baseline years. */
  baselineMean: number;
}

export interface EndemicChannel {
  year: number;
  latestMonth: number;
  baselineYears: number[];
  months: ChannelMonth[];
  enough: boolean;
}

/**
 * WHO quartile endemic channel for the latest year: quartiles of the same month over up to the 5 previous
 * years, epidemic threshold = mean + 2 SD. `enough` is false with fewer than 3 baseline years.
 */
export function endemicChannel(series: MonthPoint[], latest: number): EndemicChannel {
  const year = yearOf(latest);
  const latestMonth = (latest % 12) + 1;
  const cases = new Map(series.map((p) => [p.t, p.totals.cases]));
  const firstYear = series.length ? series[0].year : year;
  const baselineYears = Array.from({ length: 5 }, (_, i) => year - 5 + i).filter((y) => y >= firstYear && (y > firstYear || series[0].month === 1));
  const months = MONTHS.map((name, i) => {
    const m = i + 1;
    const values = baselineYears.map((y) => cases.get(y * 12 + i) ?? 0).sort((a, b) => a - b);
    const mu = mean(values);
    return {
      month: m,
      label: name.slice(0, 3),
      q1: Math.round(quantile(values, 0.25)),
      median: Math.round(quantile(values, 0.5)),
      q3: Math.round(quantile(values, 0.75)),
      threshold: Math.round(mu + 2 * sampleSd(values)),
      current: m <= latestMonth ? (cases.get(year * 12 + i) ?? 0) : null,
      previous: cases.get((year - 1) * 12 + i) ?? 0,
      baselineMean: Math.round(mu),
    };
  });
  return { year, latestMonth, baselineYears, months, enough: baselineYears.length >= 3 };
}

/* ------------------------------- Seasonality ------------------------------ */

export interface Seasonality {
  months: { month: number; label: string; share: number; recentShare: number }[];
  /** Strongest consecutive 3-month window (share of the annual cases it carries). */
  peak: { from: string; to: string; share: number } | null;
  completeYears: number;
}

/** Seasonal index: average share of a year's cases falling in each calendar month, over complete years only. */
export function seasonality(series: MonthPoint[], latest: number): Seasonality {
  const byYear = new Map<number, number[]>();
  for (const p of series) {
    const arr = byYear.get(p.year) ?? Array(12).fill(null);
    arr[p.month - 1] = p.totals.cases;
    byYear.set(p.year, arr);
  }
  const complete = [...byYear]
    .filter(([y, arr]) => arr.every((v) => v !== null) && (y < yearOf(latest) || latest % 12 === 11))
    .map(([y, arr]) => ({ y, arr: arr as number[], total: (arr as number[]).reduce((s, v) => s + v, 0) }))
    .filter((x) => x.total > 0)
    .sort((a, b) => a.y - b.y);
  const share = (rows: typeof complete) => Array.from({ length: 12 }, (_, i) => (rows.length ? mean(rows.map((x) => (x.arr[i] / x.total) * 100)) : 0));
  const all = share(complete);
  const recent = share(complete.slice(-3));
  let peak: Seasonality["peak"] = null;
  if (complete.length) {
    let best = -1;
    for (let i = 0; i + 2 < 12; i++) {
      const s = all[i] + all[i + 1] + all[i + 2];
      if (s > best) {
        best = s;
        peak = { from: MONTHS[i].slice(0, 3), to: MONTHS[i + 2].slice(0, 3), share: s };
      }
    }
  }
  return { months: MONTHS.map((m, i) => ({ month: i + 1, label: m.slice(0, 3), share: all[i], recentShare: recent[i] })), peak, completeYears: complete.length };
}

/** Mean monthly count of one measure per calendar month over the last `years` complete years. */
export function monthlyProfile(series: MonthPoint[], latest: number, key: "pf" | "pv" | "mixed" | "cases", years = 5): { label: string; value: number }[] {
  const lastComplete = latest % 12 === 11 ? yearOf(latest) : yearOf(latest) - 1;
  const use = series.filter((p) => p.year > lastComplete - years && p.year <= lastComplete);
  return MONTHS.map((m, i) => {
    const v = use.filter((p) => p.month === i + 1).map((p) => p.totals[key]);
    return { label: m.slice(0, 3), value: mean(v) };
  });
}

/* ---------------------- Aberration (outbreak-signal) detection ------------------------ */

export interface Signal {
  t: number;
  cases: number;
  expected: number;
  /** Standardised excess over the same-season baseline. ≥ 2 = signal, ≥ 3 = strong signal. */
  z: number;
}

/**
 * Same-season aberration index (in the spirit of CDC EARS): the baseline is the same month ±1 over the
 * previous 5 years; the spread is floored at the Poisson SD √mean so quiet areas don't over-signal.
 */
export function signalAt(cases: Map<number, number>, t: number, firstT: number): Signal | null {
  const base: number[] = [];
  for (let k = 1; k <= 5; k++) {
    for (let d = -1; d <= 1; d++) {
      const tt = t - 12 * k + d;
      if (tt >= firstT) base.push(cases.get(tt) ?? 0);
    }
  }
  if (base.length < 6) return null;
  const mu = mean(base);
  const sd = Math.max(sampleSd(base), Math.sqrt(Math.max(mu, 1)));
  const x = cases.get(t) ?? 0;
  return { t, cases: x, expected: mu, z: (x - mu) / sd };
}

export function seriesSignals(series: MonthPoint[], count: number): Signal[] {
  if (!series.length) return [];
  const cases = new Map(series.map((p) => [p.t, p.totals.cases]));
  const firstT = series[0].t;
  return series.slice(-count).map((p) => signalAt(cases, p.t, firstT)).filter((s): s is Signal => s !== null);
}

/* -------------------------------- Area tables ------------------------------- */

export type AreaLevel = "district" | "upazila";

export interface AreaRow {
  key: string;
  name: string;
  parent: string;
  last12: Totals;
  prev12: Totals;
  /** Months since the last month with a case (0 = cases in the latest month); null = no case in the data. */
  zeroStreak: number | null;
  monthsWithCases24: number;
  /** Cases for each of the last 24 months, oldest first. */
  spark: number[];
  signal: Signal | null;
  allTimeCases: number;
  /** Cases in the 12 months before the previous 12 (age 24–35) — separates "cleared" from "never". */
  earlier12Cases: number;
}

export function areaRows(records: readonly MisRecord[], level: AreaLevel, latest: number): AreaRow[] {
  type Acc = { name: string; parent: string; last12: Totals; prev12: Totals; byT: Map<number, number>; all: number; earlier: number };
  const groups = new Map<string, Acc>();
  let firstT = Infinity;
  for (const r of records) {
    const t = recT(r);
    if (t < firstT) firstT = t;
    const key = level === "district" ? r.districtName : String(r.upazilaId);
    let g = groups.get(key);
    if (!g) {
      g = { name: level === "district" ? r.districtName : r.upazilaName, parent: level === "district" ? r.divisionName : r.districtName, last12: emptyTotals(), prev12: emptyTotals(), byT: new Map(), all: 0, earlier: 0 };
      groups.set(key, g);
    }
    const age = latest - t;
    if (age >= 0 && age < 12) addRecord(g.last12, r);
    else if (age >= 12 && age < 24) addRecord(g.prev12, r);
    else if (age >= 24 && age < 36) g.earlier += r.cases;
    g.byT.set(t, (g.byT.get(t) ?? 0) + r.cases);
    g.all += r.cases;
  }
  return [...groups].map(([key, g]) => {
    let lastCase: number | null = null;
    for (const [t, c] of g.byT) if (c > 0 && t <= latest && (lastCase === null || t > lastCase)) lastCase = t;
    const spark = Array.from({ length: 24 }, (_, i) => g.byT.get(latest - 23 + i) ?? 0);
    return {
      key,
      name: g.name,
      parent: g.parent,
      last12: g.last12,
      prev12: g.prev12,
      zeroStreak: lastCase === null ? null : latest - lastCase,
      monthsWithCases24: spark.filter((v) => v > 0).length,
      spark,
      signal: Number.isFinite(firstT) ? signalAt(g.byT, latest, firstT) : null,
      allTimeCases: g.all,
      earlier12Cases: g.earlier,
    };
  });
}

/* ------------------------------- Concentration ------------------------------ */

export interface Concentration {
  total: number;
  /** Smallest number of areas that together hold 80% of the cases. */
  n80: number;
  areas: number;
  gini: number;
}

/** How unevenly cases are spread: areas needed for 80% of cases and the Gini coefficient (0 = even, 1 = one area). */
export function concentration(values: number[]): Concentration {
  const desc = values.filter((v) => v >= 0).sort((a, b) => b - a);
  const total = desc.reduce((s, v) => s + v, 0);
  if (!desc.length || total === 0) return { total, n80: 0, areas: desc.length, gini: 0 };
  let run = 0;
  let n80 = 0;
  for (const v of desc) {
    run += v;
    n80++;
    if (run / total >= 0.8) break;
  }
  const asc = [...desc].reverse();
  const n = asc.length;
  const weighted = asc.reduce((s, v, i) => s + (i + 1) * v, 0);
  return { total, n80, areas: n, gini: (2 * weighted) / (n * total) - (n + 1) / n };
}

/* --------------------------------- API strata -------------------------------- */

/** Analyst-defined API strata (cases per 1,000 population at risk per year) for tracking movement between risk classes. */
export const STRATA = [
  { key: "zero", label: "No cases", color: "#b9b9b6" },
  { key: "veryLow", label: "Very low (API < 1)", color: "#fde9a8" },
  { key: "low", label: "Low (1 – < 10)", color: "#fbbf5a" },
  { key: "moderate", label: "Moderate (10 – < 50)", color: "#e4502f" },
  { key: "high", label: "High (≥ 50)", color: "#8f1414" },
] as const;

export function stratumOf(api: number | null, cases: number): number | null {
  if (api === null) return null;
  if (cases === 0) return 0;
  if (api < 1) return 1;
  if (api < 10) return 2;
  if (api < 50) return 3;
  return 4;
}

/** Per year, how many population-covered upazilas fall in each stratum. */
export function strataByYear(records: readonly MisRecord[]): { year: number; counts: number[]; total: number }[] {
  const perUpazilaYear = groupTotals(records, (r) => `${r.year}|${r.upazilaId}`);
  const byYear = new Map<number, number[]>();
  for (const [key, t] of perUpazilaYear) {
    const s = stratumOf(measureValue(t, "api"), t.cases);
    if (s === null) continue;
    const year = Number(key.split("|")[0]);
    const arr = byYear.get(year) ?? Array(STRATA.length).fill(0);
    arr[s]++;
    byYear.set(year, arr);
  }
  return [...byYear].sort((a, b) => a[0] - b[0]).map(([year, counts]) => ({ year, counts, total: counts.reduce((s, v) => s + v, 0) }));
}

/* ---------------------------------- Helpers --------------------------------- */

export const share = (part: number, whole: number) => percentOf(part, whole);
