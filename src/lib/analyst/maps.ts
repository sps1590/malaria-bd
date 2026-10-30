/**
 * "Make a map of …": a choropleth of one measure for a region (all Bangladesh, a division, a district,
 * the endemic districts…) at division, district or upazila level. The server queries the values and
 * picks the colour classes; the browser draws the boundaries (public/geo) and zooms to the region.
 */
import { canonicalGeoName, upazilaMatchKey } from "@/lib/malaria-metrics";
import type { AreaLookup, AreaSel } from "./areas";
import { AREA_GROUPS, metricOf, type MetricDef } from "./catalog";
import { fmtMetric, labelG, pretty, sentence } from "./format";
import type { Part } from "./handlers";
import type { Parsed } from "./nlu";
import { runAgg, type AggRow, type RunLog } from "./query";
import type { Bounds } from "./store";
import { fmtN, joinList } from "./text";
import { labelRange, plabel } from "./time";
import type { MapSpec, TableSpec } from "./types";
import { cellFormat } from "./format";

type Level = "division" | "district" | "upazila";
const DEPTH: Record<Level, number> = { division: 1, district: 2, upazila: 3 };

// Same palettes and "red = high for this kind of area" case classes as the BI & GIS Map tab.
const PALETTE = ["#fef9c3", "#fde68a", "#fbbf24", "#f97316", "#dc2626"];
const CASE_PALETTE = ["#b9b9b6", "#fde9a8", "#fbbf5a", "#f5893a", "#e4502f", "#b91c1c"];
const CASE_BREAKS: Record<Level, number[]> = { division: [0, 9, 250, 500, 1000], district: [0, 9, 100, 250, 500], upazila: [0, 9, 50, 100, 200] };
const NO_DATA = "#eceae4";

function quantileBreaks(values: number[], classes = PALETTE.length): number[] {
  const unique = [...new Set(values)].sort((a, b) => a - b);
  if (unique.length < 2) return [];
  const n = Math.min(classes, unique.length);
  const breaks: number[] = [];
  for (let i = 1; i < n; i++) breaks.push(unique[Math.floor((i * unique.length) / n) - 1]);
  return [...new Set(breaks)];
}

const classColor = (index: number, breakCount: number, cases: boolean) =>
  cases ? CASE_PALETTE[index] : PALETTE[breakCount ? Math.round((index * (PALETTE.length - 1)) / breakCount) : 0];

function legendLabels(breaks: number[], def: MetricDef): string[] {
  const counts = def.unit === "count" && breaks.every(Number.isInteger);
  const f = (v: number) => (counts ? fmtN(v, 0) : fmtN(v, v >= 100 ? 0 : v >= 10 ? 1 : 2));
  return Array.from({ length: breaks.length + 1 }, (_, i) => {
    const lo = i === 0 ? null : breaks[i - 1];
    const hi = i < breaks.length ? breaks[i] : null;
    if (counts) {
      if (lo === null) return hi === 0 ? "0" : `≤ ${f(hi ?? 0)}`;
      if (hi === null) return `> ${f(lo)}`;
      return lo + 1 === hi ? f(hi) : `${f(lo + 1)} – ${f(hi)}`;
    }
    if (lo === null) return `≤ ${f(hi ?? 0)}`;
    if (hi === null) return `> ${f(lo)}`;
    return `${f(lo)} – ${f(hi)}`;
  });
}

/** District names covered by a selection (a division expands to its districts). */
function districtsOf(lk: AreaLookup, a: AreaSel): string[] {
  if (a.level === "division") return lk.index.districts.filter((d) => d.division === a.division).map((d) => d.name);
  return a.districts ?? [];
}

export async function mapReply(p: Parsed, bounds: Bounds, lk: AreaLookup, log: RunLog): Promise<Part> {
  const assumptions: string[] = [];
  const areas = p.areas.slice(0, 6);

  // ---- measure (a map shows one)
  const candidates = p.metrics.filter((k) => !metricOf(k).distinct);
  const specific = candidates.filter((k) => k !== "cases");
  const M = metricOf(specific[0] ?? candidates[0] ?? "cases");
  if (specific.length > 1) assumptions.push(`A map shows one measure at a time, so I mapped **${M.label}** (ask for the others separately).`);

  // ---- level: asked for, else districts for the country and upazilas for a region
  const regionDepth = areas.length ? Math.max(...areas.map((a) => (a.level === "division" || a.level === "group" ? 1 : 2))) : 0;
  const asked = [p.group, p.groupLevel].find((g): g is Level => !!g && (AREA_GROUPS as string[]).includes(g)) ?? null;
  let level: Level = asked ?? (areas.length ? "upazila" : "district");
  if (!asked) assumptions.push(`I drew the map at **${level}** level${areas.length ? " for the region you named" : ""} — say “by ${level === "district" ? "upazila" : "district"}” for a different level.`);
  if (DEPTH[level] <= regionDepth) {
    const promoted: Level = regionDepth === 1 ? "district" : "upazila";
    assumptions.push(`A ${level}-level map of a single ${regionDepth === 1 ? "division" : "district"} would be one shape, so I used **${promoted}** level.`);
    level = promoted;
  }

  // ---- period
  const hasRange = !!p.time && p.time.from >= 0;
  const from = hasRange ? p.time!.from : bounds.latestP - 11;
  const to = hasRange ? p.time!.to : bounds.latestP;
  const prefix = p.time?.months?.length ? `${p.time.label.includes(" · ") ? p.time.label.split(" · ")[0] : p.time.label} · ` : "";
  const period = prefix + labelRange(from, to, bounds.latestP);
  if (!hasRange) assumptions.push(`No period was given, so I used the **last 12 months** (${plabel(bounds.latestP - 11)} – ${plabel(bounds.latestP)}).`);

  const scope = areas.length ? joinList(areas.map((a) => a.label)) : "Bangladesh";
  const levelWord = level === "upazila" ? "upazilas" : level === "district" ? "districts" : "divisions";

  // ---- data (also tests / cases / deaths for the tooltips)
  const extra = ["cases", "deaths", "tests"].filter((k) => k !== M.key).map(metricOf);
  const rows = await runAgg(
    { metrics: [M, ...extra], group: level, areas, from, to, months: p.time?.months, withParts: true },
    log,
    `Values for the map: ${M.label} by ${level}`,
  );

  const num = (r: AggRow, k: string) => (typeof r[k] === "number" ? (r[k] as number) : null);
  const reliable = (r: AggRow) => {
    if (!M.guard) return true;
    const den = M.guard.what === "tests" ? num(r, "tests") : num(r, "cases");
    return den !== null && den >= M.guard.min;
  };
  const cells = rows.map((r) => {
    const name = level === "upazila" ? String(r.u) : labelG(level, r.g);
    const inOneDistrict = level === "upazila" && areas.length === 1 && areas[0].level === "district";
    const key = level === "upazila" ? `${canonicalGeoName(String(r.d))}|${upazilaMatchKey(String(r.u))}` : canonicalGeoName(String(r.g));
    const value = reliable(r) ? num(r, M.key) : null;
    const full = level === "upazila" && !inOneDistrict ? `${name} (${pretty(String(r.d))})` : name;
    return { r, key, name: full, value };
  });
  const withValue = cells.filter((c) => c.value !== null);
  if (!withValue.length) {
    return {
      text: `There are no reports to map for **${scope}** in ${period}${M.guard ? ` (rates need at least ${M.guard.min} ${M.guard.what} per area)` : ""}. Try a longer period or a different measure.`,
      suggestions: [`Map of cases in ${scope} for the last 24 months`, "Map of cases by district in the last 12 months"],
    };
  }

  // ---- colour classes
  const useCaseClasses = M.key === "cases";
  const values = withValue.map((c) => c.value as number);
  const breaks = useCaseClasses ? CASE_BREAKS[level] : quantileBreaks(values);
  const colorOf = (v: number) => classColor(breaks.filter((b) => v > b).length, breaks.length, useCaseClasses);
  const labels = legendLabels(breaks, M);
  const legend = labels.map((label, i) => ({ color: classColor(i, breaks.length, useCaseClasses), label }));

  const tipFor = (c: (typeof cells)[number]) =>
    [`${M.label}: ${c.value === null ? "no data" : fmtMetric(M, c.value)}`, ...(M.key === "cases" ? [] : [`Cases: ${fmtN(num(c.r, "cases"))}`]), ...(M.key === "deaths" ? [] : [`Deaths: ${fmtN(num(c.r, "deaths"))}`]), ...(M.key === "tests" ? [] : [`Tested: ${fmtN(num(c.r, "tests"))}`])].join(" · ");

  // ---- which boundaries to draw
  const districtNames = [...new Set(areas.flatMap((a) => districtsOf(lk, a)))];
  const filter: MapSpec["filter"] =
    areas.length === 0 ? null
    : level === "division" ? { prop: "ADM1_EN", keys: [...new Set(areas.map((a) => canonicalGeoName(a.division ?? "")))] }
    : { prop: "ADM2_EN", keys: districtNames.map(canonicalGeoName) };

  const map: MapSpec = {
    title: `${M.label} by ${level} — ${scope}, ${period}`,
    level,
    filter,
    metricLabel: M.label,
    rows: cells.map((c) => ({ key: c.key, name: c.name, value: c.value, color: c.value === null ? NO_DATA : colorOf(c.value), tip: tipFor(c) })),
    legend,
    noData: NO_DATA,
  };

  // ---- table + narrative
  const ranked = [...withValue].sort((a, b) => (b.value as number) - (a.value as number));
  const zero = withValue.filter((c) => c.value === 0).length;
  const total = M.unit === "count" && !M.distinct ? values.reduce((s, v) => s + v, 0) : null;
  const top = ranked.slice(0, 3);
  let text = `**Map: ${M.label} by ${level} — ${scope}, ${period}.**\n\n`;
  text += `**${withValue.length}** ${levelWord} reported data${total !== null ? `, **${fmtN(total)}** ${sentence(M.label)} in all` : ""}. `;
  text += `Highest: ${joinList(top.map((c) => `**${c.name}** (${fmtMetric(M, c.value)})`))}.`;
  if (zero) text += ` ${zero} ${zero === 1 ? level : levelWord} recorded zero.`;
  if (useCaseClasses) text += ` Colours follow the dashboard scale: red = above ${fmtN(CASE_BREAKS[level][4])} cases for a ${level}, grey = none.`;
  else text += " Darker colour = higher value; pale grey = no data.";
  text += "\n";
  const notes = [...assumptions];
  if (M.caveat) notes.push(M.caveat);
  if (M.guard) notes.push(`Areas with fewer than ${M.guard.min} ${M.guard.what} are shown as “no data”, because a rate from so few is unreliable.`);
  if (level === "upazila") notes.push("Hospital and central-reporting units have no boundary, so they are listed in the table but not coloured on the map.");
  text += `\n${notes.map((n) => `_${n.replace(/\*\*/g, "")}_`).join("\n")}`;

  const table: TableSpec = {
    columns: [
      { key: "rank", label: "#", format: "int" },
      { key: "area", label: level[0].toUpperCase() + level.slice(1), format: "text" },
      { key: M.key, label: M.label, format: cellFormat(M) },
      ...extra.map((m) => ({ key: m.key, label: m.label, format: cellFormat(m) })),
    ],
    rows: ranked.map((c, i) => ({ rank: i + 1, area: c.name, [M.key]: c.value, ...Object.fromEntries(extra.map((m) => [m.key, num(c.r, m.key)])) })),
  };

  const other = level === "district" ? "upazila" : "district";
  const place = areas.length ? areas.map((a) => a.label.replace(/ (division|district)$/, "")).join(" and ") : "Bangladesh";
  return {
    text, table, map, scope, period, measure: M.label,
    suggestions: [
      M.key === "cases" ? `Map of deaths in ${place}` : `Map of cases in ${place}`,
      `Map of ${M.label.toLowerCase().replace(/ \(.*\)$/, "")} by ${other} in ${place}`,
      `Top 10 ${levelWord} by ${sentence(M.label).replace(/ \(.*\)$/, "")} in ${place}`,
    ],
  };
}
