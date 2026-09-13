import { climateCorrelation, getWeather, malariaStats, type Level } from "@/lib/agent-data";
import { getSql } from "@/lib/db";

/** Monthly ERA5 weather aligned with confirmed cases, plus lagged climate–malaria correlations. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const area = params.get("area") || undefined;
  const level = (params.get("level") || undefined) as Level | undefined;
  const years = Math.min(Math.max(Number(params.get("years") ?? 6) || 6, 2), 15);

  const sql = getSql();
  const [{ last }] = await sql<{ last: number }[]>`SELECT max(report_year)::int AS last FROM mis_monthly`;
  const yearFrom = last - years + 1;
  const scopedArea = level === "national" ? undefined : area;
  const scopedLevel = level === "national" ? undefined : level;

  const [weather, correlation, stats] = await Promise.all([
    getWeather({ area: scopedArea, level: scopedLevel, yearFrom, yearTo: last, groupBy: "month" }),
    climateCorrelation({ area: scopedArea, level: scopedLevel }),
    malariaStats({ area: scopedArea, level: scopedLevel, yearFrom, yearTo: last, groupBy: "month" }),
  ]);

  const cases = new Map("rows" in stats && stats.rows ? stats.rows.map((r) => [r.group, r.cases]) : []);
  const rows = weather.available && "rows" in weather && weather.rows ? weather.rows : [];
  const series = rows.map((r) => ({ ...r, cases: cases.get("period" in r ? r.period : "") ?? 0 }));

  return Response.json({
    available: series.length > 0,
    note: "note" in weather ? weather.note : undefined,
    scope: "scope" in weather ? weather.scope : undefined,
    source: "ERA5 reanalysis (ECMWF Copernicus) via Open-Meteo",
    series,
    correlation,
  });
}
