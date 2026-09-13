import { areaFilter, getAreaIndex, resolveArea, type Level } from "@/lib/agent-data";
import { getSql } from "@/lib/db";
import { MONTHS } from "@/lib/malaria-metrics";

const BASELINE_YEARS = 5;

function quantile(sorted: number[], p: number) {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
}

/**
 * Endemic channel for the latest year: quartiles of the same month over the previous 5 years
 * (WHO quartile method) and an epidemic threshold of mean + 2 SD.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const areaName = params.get("area") || undefined;
  const level = (params.get("level") || undefined) as Level | undefined;
  const sql = getSql();
  const area = areaName && level !== "national" ? resolveArea(await getAreaIndex(sql), areaName, level) : null;
  if (areaName && level !== "national" && !area) return Response.json({ error: "Unknown area" }, { status: 404 });

  const [latest] = await sql<{ year: number; month: number }[]>`
    SELECT report_year::int AS year, max(report_month)::int AS month FROM mis_monthly
    WHERE report_year = (SELECT max(report_year) FROM mis_monthly) GROUP BY 1`;
  const rows = await sql<{ y: number; m: number; cases: number }[]>`
    SELECT report_year::int AS y, report_month::int AS m, sum(cases)::int AS cases
    FROM mis_monthly
    WHERE report_year BETWEEN ${latest.year - BASELINE_YEARS} AND ${latest.year} ${areaFilter(sql, area)}
    GROUP BY 1, 2`;
  const value = new Map(rows.map((r) => [r.y * 100 + r.m, r.cases]));
  const baselineYears = Array.from({ length: BASELINE_YEARS }, (_, i) => latest.year - BASELINE_YEARS + i);

  const months = MONTHS.map((name, i) => {
    const m = i + 1;
    const values = baselineYears.map((y) => value.get(y * 100 + m) ?? 0).sort((a, b) => a - b);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
    return {
      month: m,
      label: name.slice(0, 3),
      q1: Math.round(quantile(values, 0.25)),
      median: Math.round(quantile(values, 0.5)),
      q3: Math.round(quantile(values, 0.75)),
      threshold: Math.round(mean + 2 * sd),
      current: m <= latest.month ? (value.get(latest.year * 100 + m) ?? 0) : null,
      previous: value.get((latest.year - 1) * 100 + m) ?? 0,
    };
  });

  return Response.json({ scope: area?.label ?? "Bangladesh", year: latest.year, latestMonth: latest.month, baselineYears, months });
}
