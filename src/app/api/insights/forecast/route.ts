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
        SELECT model, accuracy_pct, accuracy_3m_pct, wape, mae, mase, backtest_origins, train_start, train_end, candidates, notes, created_at
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

  return Response.json({
    available: true,
    areas,
    selected,
    history: history.slice(-60),
    cases: targets[0],
    deaths: targets[1],
  });
}
