/** Value/label formatting shared by the analyst's answer builders. */
import { DIVISION_DISTRICTS, canonicalGeoName } from "@/lib/malaria-metrics";
import { type GroupKey, type MetricDef } from "./catalog";
import { SHORT } from "./time";
import { fmtN } from "./text";
import type { CellFormat } from "./types";

export const fmtMetric = (def: MetricDef, v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (def.unit === "count") return fmtN(v, 0);
  if (def.unit === "pct") return `${fmtN(v, def.decimals)}%`;
  return fmtN(v, def.decimals);
};

export const cellFormat = (def: MetricDef): CellFormat =>
  def.unit === "count" ? "int" : def.unit === "pct" ? (def.decimals >= 2 ? "pct2" : "pct1") : "d2";

export const chartFormat = (def: MetricDef): "int" | "d2" | "pct1" | "pct2" => {
  const f = cellFormat(def);
  return f === "int" || f === "d2" || f === "pct1" || f === "pct2" ? f : "int";
};

/** Lower-case a metric label for use inside a sentence, keeping species names and acronyms intact. */
export const sentence = (label: string): string =>
  /^(P\.|[A-Z]{2,}|Age)/.test(label) ? (label.startsWith("Age") ? label.toLowerCase() : label) : label.charAt(0).toLowerCase() + label.slice(1);

/** Official division/district spellings, keyed by the same canonical key the data are matched on. */
const OFFICIAL = new Map<string, string>(
  Object.entries(DIVISION_DISTRICTS).flatMap(([division, districts]) => [division, ...districts].map((n) => [canonicalGeoName(n), n] as const)),
);

/** The MIS uses older spellings ("Coxs Bazar", "Hobigonj", "Chittagong"); show the official name. */
export function pretty(name: string): string {
  const fixed = name.replace(/\bCoxs?\s?Bazar/i, "Cox's Bazar");
  const whole = OFFICIAL.get(canonicalGeoName(fixed));
  if (whole) return whole;
  return fixed.replace(/\(([^)]+)\)/g, (_m, inner: string) => `(${OFFICIAL.get(canonicalGeoName(inner)) ?? inner})`);
}

/** Human label for a group value g. */
export function labelG(group: GroupKey, g: string | number | null): string {
  if (g === null) return "—";
  if (group === "year") return String(g);
  if (group === "quarter") return `Q${String(g).slice(-1)} ${String(g).slice(0, -1)}`;
  if (group === "month") {
    const n = Number(g);
    return `${SHORT[(n % 100) - 1]} ${Math.floor(n / 100)}`;
  }
  if (group === "calmonth") return SHORT[Number(g) - 1];
  return pretty(String(g));
}

/** Chronological sort key for time groups. */
export const timeOrder = (g: string | number | null): number => Number(g);

export const unitWord = (group: GroupKey): string =>
  group === "year" ? "year" : group === "quarter" ? "quarter" : group === "month" ? "month" : group === "calmonth" ? "calendar month" : "period";

const SINGULAR: Record<string, string> = {
  cases: "confirmed case", deaths: "death", severe: "severe case", uncomplicated: "uncomplicated case", male: "male case",
  female: "female case", pregnant: "pregnant woman", tests: "person tested", referred: "referral", treated: "treated case",
};
/** "5 deaths" / "1 death": the metric's noun, singular when the value is exactly 1. */
export const nounFor = (def: MetricDef, v: number | null): string => (v === 1 && SINGULAR[def.key] ? SINGULAR[def.key] : sentence(def.label));
