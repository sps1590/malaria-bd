import { areaFilter, getAreaIndex, resolveArea, type Level } from "@/lib/agent-data";
import { getSql, tableExists } from "@/lib/db";

type AreaRow = { level: Level; area_key: string; area_name: string; accuracy_pct: number | null; accuracy_3m_pct: number | null; model: string };

const LEVEL_ORDER: Record<string, number> = { national: 0, division: 1, district: 2 };

/** Forecast, back-test and recent history (cases + deaths) for one area. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const sql = getSql();
  if (!(await tableExists(sql, "forecast_runs"))) return Response.json({ available: false, areas: [] });

  const areas = (
    await sql<AreaRow[]>`
      SELECT DISTINCT ON (level, area_key) level, area_key, area_name, accuracy_pct, accuracy_3m_pct, model
      FROM forecast_runs WHERE target = 'cases'
      ORDER BY level, area_key, created_at DESC`
  ).sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.area_name.localeCompare(b.area_name));

  const level = params.get("level") ?? "national";
  const key = params.get("key") ?? "bangladesh";
  const selected = areas.find((a) => a.level === level && a.area_key === key);
  if (!selected) return Response.json({ available: areas.length > 0, areas, error: "Unknown forecast area" }, { status: 404 });

  const area = selected.level === "national" ? null : resolveArea(await getAreaIndex(sql), selected.area_name, selected.level);
  const [history, ...targets] = await Promise.all([
    sql<{ year: number; month: number; cases: number; deaths: number }[]>`
      SELECT report_year::int AS year, report_month::int AS month, sum(cases)::int AS cases, sum(deaths)::int AS deaths
      FROM mis_monthly WHERE true ${areaFilter(sql, area)}
      GROUP BY 1, 2 ORDER BY 1, 2`,
    ...(["cases", "deaths"] as const).map(async (target) => {
      const [run] = await sql`
        SELECT model, accuracy_pct, accuracy_3m_pct, wape, mae, mase, backtest_origins, train_start, train_end,
               (candidates #>> '{}')::jsonb AS candidates, notes, created_at -- tolerates JSON stored as a string
        FROM forecast_runs WHERE level = ${level} AND area_key = ${key} AND target = ${target}
        ORDER BY created_at DESC LIMIT 1`;
      const forecast = await sql`
        SELECT year, month, yhat, lo80, hi80, lo95, hi95 FROM forecast_monthly
        WHERE level = ${level} AND area_key = ${key} AND target = ${target} ORDER BY year, month`;
      const backtest = await sql`
        SELECT year, month, horizon, actual, predicted FROM forecast_backtest
        WHERE level = ${level} AND area_key = ${key} AND target = ${target} ORDER BY year, month`;
      return { target, run: run ?? null, forecast, backtest };
    }),
  ]);

  // Live tracking: archived forecasts made before each month's data existed, compared with what was then reported.
  const live = (await tableExists(sql, "forecast_archive"))
    ? await sql<{ target: string; horizon: number; months: number; abs_error: number; actual: number }[]>`
        WITH actual AS (
          SELECT report_year::int AS year, report_month::int AS month, sum(cases)::float AS cases, sum(deaths)::float AS deaths
          FROM mis_monthly WHERE true ${areaFilter(sql, area)}
          GROUP BY 1, 2
        )
        SELECT fa.target, fa.horizon::int AS horizon, count(*)::int AS months,
               sum(abs(fa.yhat - CASE WHEN fa.target = 'cases' THEN a.cases ELSE a.deaths END))::float AS abs_error,
               sum(CASE WHEN fa.target = 'cases' THEN a.cases ELSE a.deaths END)::float AS actual
        FROM forecast_archive fa
        JOIN actual a ON a.year = fa.year AND a.month = fa.month
        WHERE fa.level = ${level} AND fa.area_key = ${key} AND fa.horizon <= 3
        GROUP BY 1, 2 ORDER BY 1, 2`
    : [];

  return Response.json({
    available: true,
    areas,
    selected,
    history: history.slice(-60),
    cases: targets[0],
    deaths: targets[1],
    live: live.map((l) => ({
      target: l.target,
      horizon: l.horizon,
      months: l.months,
      accuracy_pct: l.actual > 0 ? Math.round(1000 * (1 - l.abs_error / l.actual)) / 10 : null,
      mae: l.abs_error / l.months,
    })),
  });
}
