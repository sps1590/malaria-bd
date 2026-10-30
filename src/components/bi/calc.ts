/**
 * Pure analysis behind the BI & GIS Map tab: comparison periods, change maths, the auto-written findings,
 * biggest movers, burden concentration and outbreak signals. Everything works on the in-browser MIS records.
 */
import { areaRows, concentration, periodLabel, recT, type AreaRow } from "@/lib/epi-calc";
import {
  MONTHS, formatMeasure, measureLabel, measureValue, percentOf, totalsOf,
  type MeasureKey, type MisRecord, type Totals,
} from "@/lib/malaria-metrics";

/* ------------------------------- Period ------------------------------- */

export interface PeriodSel {
  year: number | "all";
  monthFrom: number;
  monthTo: number;
}

export const FULL_YEAR = (sel: PeriodSel) => sel.monthFrom === 1 && sel.monthTo === 12;
export const inMonths = (r: { month: number }, sel: PeriodSel) => r.month >= sel.monthFrom && r.month <= sel.monthTo;

export function monthRangeLabel(sel: PeriodSel): string {
  if (FULL_YEAR(sel)) return "";
  const a = MONTHS[sel.monthFrom - 1].slice(0, 3);
  return sel.monthFrom === sel.monthTo ? a : `${a}–${MONTHS[sel.monthTo - 1].slice(0, 3)}`;
}

/** Records of the chosen year(s) and month window. */
export function selectPeriod<T extends MisRecord>(records: readonly T[], sel: PeriodSel): T[] {
  return records.filter((r) => (sel.year === "all" || r.year === sel.year) && inMonths(r, sel));
}

/**
 * The comparison period for a single-year selection: the same months of the previous year — only months that
 * the selected year actually has, so a part-year (e.g. Jan–Sep) is never compared with a full year.
 */
export function comparisonRecords<T extends MisRecord>(records: readonly T[], current: readonly T[], sel: PeriodSel): { rows: T[]; label: string } | null {
  if (sel.year === "all") return null;
  const prevYear = sel.year - 1;
  const months = new Set(current.map((r) => r.month));
  if (!months.size) return null;
  const rows = records.filter((r) => r.year === prevYear && months.has(r.month) && inMonths(r, sel));
  if (!rows.length) return null;
  const sorted = [...months].sort((a, b) => a - b);
  const span = sorted.length === 12 ? "" : ` (${MONTHS[sorted[0] - 1].slice(0, 3)}–${MONTHS[sorted[sorted.length - 1] - 1].slice(0, 3)})`;
  return { rows, label: `${prevYear}${span}` };
}

/* -------------------------------- Change -------------------------------- */

/** Percent change; Infinity = rose from zero; null = nothing to compare. */
export function pctDelta(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null) return null;
  if (prev === 0) return cur === 0 ? 0 : cur > 0 ? Infinity : null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

/** For which indicators a fall is good news (null = neutral: testing effort). */
export const GOOD_WHEN_DOWN: Record<string, boolean | null> = {
  cases: true, deaths: true, tests: null, tpr: true, pfShare: true, api: true, aber: null,
};

export const fmtPct = (p: number | null) => (p === null ? "—" : p === Infinity ? "new" : `${Math.abs(p) < 10 ? Math.abs(p).toFixed(1) : Math.abs(Math.round(p))}%`);
export const arrow = (p: number | null) => (p === null || p === Infinity ? "" : Math.abs(p) < 0.5 ? "≈" : p > 0 ? "▲" : "▼");

/* -------------------------------- Movers -------------------------------- */

export interface AreaValue {
  key: string;
  label: string;
  totals: Totals;
  value: number | null;
}

export interface Mover {
  key: string;
  label: string;
  cur: number | null;
  prev: number | null;
  delta: number;
  pct: number | null;
}

/** Areas ranked by how much the selected measure moved; thin areas (few cases/tests) are left out of the ranking. */
export function movers(cur: Map<string, AreaValue>, prev: Map<string, AreaValue>, metric: MeasureKey): { rises: Mover[]; falls: Mover[] } {
  const rate = metric !== "cases" && metric !== "deaths" && metric !== "tests";
  const out: Mover[] = [];
  for (const key of new Set([...cur.keys(), ...prev.keys()])) {
    const c = cur.get(key);
    const p = prev.get(key);
    const cv = c?.value ?? (rate ? null : 0);
    const pv = p?.value ?? (rate ? null : 0);
    if (cv === null || pv === null) continue;
    if (rate) {
      const enough = (t?: Totals) => (t?.tests ?? 0) >= 100;
      if (!enough(c?.totals) || !enough(p?.totals)) continue;
    } else if (Math.max(cv, pv) < 3) continue;
    out.push({ key, label: (c ?? p)!.label, cur: cv, prev: pv, delta: cv - pv, pct: pctDelta(cv, pv) });
  }
  return {
    rises: out.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 8),
    falls: out.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 8),
  };
}

/* ------------------------------- Signals ------------------------------- */

export interface SignalRow {
  name: string;
  parent: string;
  cases: number;
  expected: number;
  z: number;
  /** Key in the same format the map uses for this level. */
  mapKey: string;
}

/** Areas above their own same-season history in the newest month (signal index ≥ 2, at least 5 cases). */
export function signalRows(records: readonly MisRecord[], level: "district" | "upazila", latest: number, keyOf: (row: AreaRow) => string): { signals: SignalRow[]; watch: SignalRow[]; checked: number } {
  const rows = areaRows(records, level, latest);
  const mk = (r: AreaRow): SignalRow | null =>
    r.signal ? { name: r.name, parent: r.parent, cases: r.signal.cases, expected: r.signal.expected, z: r.signal.z, mapKey: keyOf(r) } : null;
  const all = rows.map(mk).filter((r): r is SignalRow => r !== null);
  return {
    signals: all.filter((r) => r.z >= 2 && r.cases >= 5).sort((a, b) => b.z - a.z),
    watch: all.filter((r) => r.z < 2 && r.cases >= 1).sort((a, b) => b.z - a.z).slice(0, 6),
    checked: all.length,
  };
}

/* ----------------------------- Concentration ---------------------------- */

export interface ParetoRow {
  key: string;
  label: string;
  value: number;
  share: number;
  cumulative: number;
}

/** Areas ordered by cases with each one's share and the running share — where the burden actually sits. */
export function pareto(areas: { key: string; label: string; cases: number }[]): { rows: ParetoRow[]; n80: number; total: number; gini: number; count: number } {
  const sorted = areas.filter((a) => a.cases > 0).sort((a, b) => b.cases - a.cases);
  const total = sorted.reduce((s, a) => s + a.cases, 0);
  let run = 0;
  const rows = sorted.map((a) => {
    run += a.cases;
    return { key: a.key, label: a.label, value: a.cases, share: total ? (a.cases / total) * 100 : 0, cumulative: total ? (run / total) * 100 : 0 };
  });
  const c = concentration(areas.map((a) => a.cases));
  return { rows, n80: c.n80, total, gini: c.gini, count: areas.length };
}

/* -------------------------------- Findings -------------------------------- */

export type Tone = "good" | "bad" | "warn" | "info";
export interface Finding {
  tone: Tone;
  text: string;
}

export interface FindingsInput {
  scope: string;
  period: string;
  levelWord: string;
  cur: Totals;
  prev: Totals | null;
  prevLabel: string | null;
  partialNote: string | null;
  areas: AreaValue[];
  pareto: ReturnType<typeof pareto>;
  risers: Mover[];
  fallers: Mover[];
  months: { label: string; cases: number }[];
  signals: { count: number; names: string[]; latestLabel: string; checked: number } | null;
}

const n0 = (v: number | null | undefined) => (v === null || v === undefined ? "—" : Math.round(v).toLocaleString("en-US"));

export function buildFindings(input: FindingsInput): Finding[] {
  let f = input;
  const out: Finding[] = [];
  const { cur, prev } = f;
  const cases = cur.cases;
  const chg = prev ? pctDelta(cases, prev.cases) : null;

  // 1. burden and change
  let head = `**${f.scope}** recorded **${n0(cases)}** confirmed ${cases === 1 ? "case" : "cases"} and **${n0(cur.deaths)}** ${cur.deaths === 1 ? "death" : "deaths"} in ${f.period}`;
  if (prev && f.prevLabel) head += ` — cases are **${arrow(chg)} ${fmtPct(chg)}** vs ${f.prevLabel} (${n0(prev.cases)})`;
  out.push({ tone: chg === null ? "info" : chg < -0.5 ? "good" : chg > 0.5 ? "bad" : "info", text: `${head}.` });

  // 2. testing
  const tpr = measureValue(cur, "tpr");
  if (cur.tests > 0 && tpr !== null) {
    const ptpr = prev ? measureValue(prev, "tpr") : null;
    const level = tpr < 1 ? "very low" : tpr < 5 ? "low" : tpr < 15 ? "moderate" : "high";
    let t = `**${n0(cur.tests)}** people were tested; test positivity is **${tpr.toFixed(2)}%** (${level}${ptpr !== null ? `, ${tpr - ptpr >= 0 ? "+" : "−"}${Math.abs(tpr - ptpr).toFixed(2)} points vs ${f.prevLabel}` : ""})`;
    if (prev && prev.tests > 0) {
      const tc = pctDelta(cur.tests, prev.tests);
      if (tc !== null && Math.abs(tc) >= 5 && chg !== null && Math.sign(tc) === Math.sign(chg) && Math.abs(tc) >= Math.abs(chg) / 2) t += `. Testing moved the same way as cases (${arrow(tc)} ${fmtPct(tc)}), so part of the change may reflect testing effort`;
    }
    out.push({ tone: tpr >= 15 ? "warn" : "info", text: `${t}.` });
  }

  // 3. geography
  const withCases = f.areas.filter((a) => a.totals.cases > 0).sort((a, b) => b.totals.cases - a.totals.cases);
  if (withCases.length >= 2 && cases > 0) {
    const top = withCases.slice(0, 3);
    const share = (top.reduce((s, a) => s + a.totals.cases, 0) / cases) * 100;
    let g = `**${top.map((a) => a.label).join(", ")}** ${top.length === 1 ? "holds" : "hold"} **${Math.round(share)}%** of cases (${withCases.length} of ${f.areas.length} ${f.levelWord} reported cases)`;
    if (f.pareto.count >= 10 && f.pareto.n80 > 0) g += `; at the finest level **${f.pareto.n80} of ${f.pareto.count}** reporting areas account for 80%`;
    out.push({ tone: "info", text: `${g}.` });
  } else if (withCases.length === 1) {
    out.push({ tone: "info", text: `All cases in this selection are in **${withCases[0].label}**.` });
  } else if (cases === 0) {
    out.push({ tone: "good", text: "**No confirmed cases** were reported in this selection." });
  }

  // 4. movers (only changes big enough to matter)
  const material = (m: Mover) => Math.abs(m.delta) >= 5 && (m.pct === Infinity || (m.pct !== null && Math.abs(m.pct) >= 5));
  f = { ...f, risers: f.risers.filter(material), fallers: f.fallers.filter(material) };
  if (prev && f.prevLabel && (f.risers.length || f.fallers.length)) {
    const bits: string[] = [];
    if (f.fallers[0]) bits.push(`biggest fall **${f.fallers[0].label}** (${n0(f.fallers[0].delta)} cases, ${arrow(f.fallers[0].pct)} ${fmtPct(f.fallers[0].pct)})`);
    if (f.risers[0]) bits.push(`biggest rise **${f.risers[0].label}** (+${n0(f.risers[0].delta)}, ${arrow(f.risers[0].pct)} ${fmtPct(f.risers[0].pct)})`);
    out.push({ tone: f.risers[0] && f.risers[0].delta >= 10 ? "warn" : "info", text: `Versus ${f.prevLabel}: ${bits.join("; ")}.` });
  }

  // 5. season
  if (f.months.length >= 4 && cases > 0) {
    const peak = [...f.months].sort((a, b) => b.cases - a.cases)[0];
    out.push({ tone: "info", text: `The highest month is **${peak.label}** with **${n0(peak.cases)}** cases (${Math.round((peak.cases / cases) * 100)}% of the period).` });
  }

  // 6. species
  if (cases >= 20) {
    const pf = percentOf(cur.pf + cur.mixed, cases);
    const pv = percentOf(cur.pv, cases);
    const ppf = prev && prev.cases >= 20 ? percentOf(prev.pf + prev.mixed, prev.cases) : null;
    if (pf !== null && pv !== null) {
      out.push({ tone: "info", text: `Falciparum (incl. mixed) is **${Math.round(pf)}%** of cases and vivax **${Math.round(pv)}%**${ppf !== null ? ` — falciparum share ${pf - ppf >= 0 ? "up" : "down"} ${Math.abs(pf - ppf).toFixed(1)} points on ${f.prevLabel}` : ""}. Vivax needs radical cure to prevent relapse.` });
    }
  }

  // 7. people
  const age = cur.ageLt1 + cur.age1to4 + cur.age5to14 + cur.age15plus;
  if (age >= 20) {
    const kids = percentOf(cur.ageLt1 + cur.age1to4 + cur.age5to14, age) ?? 0;
    const male = percentOf(cur.male, cur.male + cur.female);
    out.push({ tone: "info", text: `Children under 15 are **${Math.round(kids)}%** of cases${male !== null ? `; **${Math.round(male)}%** are male` : ""}${cur.pregnant ? `; **${n0(cur.pregnant)}** pregnant women` : ""}.` });
  }

  // 8. deaths
  if (cur.deaths > 0) {
    const cfr = measureValue(cur, "cfr");
    const worst = [...f.areas].sort((a, b) => b.totals.deaths - a.totals.deaths)[0];
    out.push({ tone: "bad", text: `**${n0(cur.deaths)}** ${cur.deaths === 1 ? "death" : "deaths"} (case fatality ${cfr === null ? "—" : `${cfr.toFixed(2)}%`})${worst && worst.totals.deaths > 0 ? `, most in **${worst.label}** (${n0(worst.totals.deaths)})` : ""}.` });
  }

  // 9. signals
  if (f.signals) {
    out.push(
      f.signals.count
        ? { tone: "bad", text: `**${f.signals.count}** ${f.signals.count === 1 ? "area is" : "areas are"} above ${f.signals.count === 1 ? "its" : "their"} usual range for ${f.signals.latestLabel}: **${f.signals.names.slice(0, 4).join(", ")}**${f.signals.count > 4 ? ` and ${f.signals.count - 4} more` : ""} — see the signals panel and the outlined areas on the map.` }
        : { tone: "good", text: `No area is above its usual range for **${f.signals.latestLabel}** (${f.signals.checked} checked against their own history).` },
    );
  }

  if (f.partialNote) out.push({ tone: "warn", text: f.partialNote });
  return out;
}

/* ------------------------------ Misc helpers ----------------------------- */

export function monthlyValues(records: readonly MisRecord[], metric: MeasureKey): Map<number, number | null> {
  const byT = new Map<number, MisRecord[]>();
  for (const r of records) {
    const t = recT(r);
    const list = byT.get(t);
    if (list) list.push(r);
    else byT.set(t, [r]);
  }
  const out = new Map<number, number | null>();
  for (const [t, rs] of byT) out.set(t, measureValue(totalsOf(rs), metric));
  return out;
}

export { formatMeasure, measureLabel, periodLabel };
