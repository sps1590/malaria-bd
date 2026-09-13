/**
 * Read-only analytical queries over the malaria data warehouse.
 * Shared by the Claude agent (as tools) and the offline assistant.
 */
import { getSql, tableExists, type Sql } from "@/lib/db";
import {
  MONTHS,
  NUMERIC_FIELDS,
  UNASSIGNED_DIVISION,
  canonicalGeoName,
  caseFatalityRate,
  percentOf,
  testPositivityRate,
  upazilaMatchKey,
} from "@/lib/malaria-metrics";

export type Level = "national" | "division" | "district" | "upazila";
export type GroupBy = "none" | "year" | "month" | "area";

const round = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits;
const pad = (n: number) => String(n).padStart(2, "0");
const periodLabel = (p: number) => `${MONTHS[p % 100 - 1]} ${Math.floor(p / 100)}`;

/* ------------------------------ Areas ------------------------------ */

export interface AreaIndex {
  divisions: string[];
  districts: { name: string; division: string }[];
  upazilas: { id: number; name: string; district: string; division: string }[];
}

let areaCache: { at: number; index: AreaIndex } | null = null;

export async function getAreaIndex(sql: Sql = getSql()): Promise<AreaIndex> {
  if (areaCache && Date.now() - areaCache.at < 10 * 60_000) return areaCache.index;
  const rows = await sql<{ upazila_id: number; upazila_name: string; district_name: string; division_name: string }[]>`
    SELECT DISTINCT ON (upazila_id) upazila_id, upazila_name, district_name, division_name
    FROM mis_monthly ORDER BY upazila_id, report_year DESC, report_month DESC`;
  const index: AreaIndex = {
    divisions: [...new Set(rows.map((r) => r.division_name))].filter((d) => d !== UNASSIGNED_DIVISION).sort(),
    districts: [...new Map(rows.map((r) => [r.district_name, { name: r.district_name, division: r.division_name }])).values()]
      .sort((a, b) => a.name.localeCompare(b.name)),
    upazilas: rows.map((r) => ({ id: r.upazila_id, name: r.upazila_name, district: r.district_name, division: r.division_name })),
  };
  areaCache = { at: Date.now(), index };
  return index;
}

export interface ResolvedArea {
  level: Exclude<Level, "national">;
  label: string;
  division: string;
  district?: string;
  upazilaIds?: number[];
}

/** Match a free-text place name to MIS areas, tolerating spelling variants (Chattogram/Chittagong…). */
export function resolveArea(index: AreaIndex, name: string, level?: Level): ResolvedArea | null {
  const key = canonicalGeoName(name);
  if (!key) return null;
  if (!level || level === "national" || level === "division") {
    const division = index.divisions.find((d) => canonicalGeoName(d) === key);
    if (division) return { level: "division", label: `${division} division`, division };
    if (level === "division") return null;
  }
  if (!level || level === "national" || level === "district") {
    const district = index.districts.find((d) => canonicalGeoName(d.name) === key);
    if (district) return { level: "district", label: `${district.name} district`, division: district.division, district: district.name };
    if (level === "district") return null;
  }
  const exact = index.upazilas.filter((u) => canonicalGeoName(u.name) === key);
  const loose = exact.length ? exact : index.upazilas.filter((u) => upazilaMatchKey(u.name) === upazilaMatchKey(name));
  if (!loose.length) return null;
  const first = loose[0];
  const districts = new Set(loose.map((u) => u.district));
  return {
    level: "upazila",
    label: districts.size === 1 ? `${first.name} upazila (${first.district} district)` : `${first.name} (${loose.length} upazilas with this name)`,
    division: first.division,
    district: districts.size === 1 ? first.district : undefined,
    upazilaIds: loose.map((u) => u.id),
  };
}

/** SQL fragment restricting mis_monthly to a resolved area (empty for national). */
export function areaFilter(sql: Sql, area: ResolvedArea | null) {
  if (area?.level === "division") return sql`AND division_name = ${area.division}`;
  if (area?.level === "district") return sql`AND district_name = ${area.district ?? ""}`;
  if (area?.level === "upazila") return sql`AND upazila_id IN ${sql(area.upazilaIds ?? [])}`;
  return sql``;
}

async function dataBounds(sql: Sql) {
  const [b] = await sql<{ first_year: number; last_year: number; latest: number }[]>`
    SELECT min(report_year)::int AS first_year, max(report_year)::int AS last_year,
           max(report_year * 100 + report_month)::int AS latest
    FROM mis_monthly`;
  return b;
}

/* ------------------------------ Malaria stats ------------------------------ */

export interface StatsInput {
  level?: Level;
  area?: string;
  yearFrom?: number;
  yearTo?: number;
  months?: number[];
  groupBy?: GroupBy;
  /** For groupBy "area": rank at this level (e.g. districts nationally) instead of the next level down. */
  rankLevel?: "division" | "district" | "upazila";
  /** For groupBy "area": ranking metric before the top-N cut. */
  sortBy?: "cases" | "deaths" | "tests" | "tpr_pct" | "pf_share_pct";
  top?: number;
}

const DEPTH = { national: 0, division: 1, district: 2, upazila: 3 } as const;

type RawRow = Record<string, string | number> & {
  division_name: string;
  district_name: string;
  upazila_name: string;
  report_year: number;
  report_month: number;
};

function summarise(acc: Record<string, number>, periods: number) {
  return {
    cases: acc.cases,
    tests: acc.tests,
    deaths: acc.deaths,
    pf: acc.pf,
    pv: acc.pv,
    mixed: acc.mixed,
    severe: acc.severe,
    treated: acc.treated,
    referred: acc.referred,
    male: acc.male,
    female: acc.female,
    pregnant: acc.pregnant,
    age_under1: acc.ageLt1,
    age_1_4: acc.age1to4,
    age_5_14: acc.age5to14,
    age_15_plus: acc.age15plus,
    active_detection: acc.acd,
    passive_detection: acc.pcd,
    tpr_pct: round(testPositivityRate(acc.cases, acc.tests)),
    pf_share_pct: round(percentOf(acc.pf + acc.mixed, acc.cases), 1),
    severe_share_pct: round(percentOf(acc.severe, acc.cases), 1),
    treated_pct: round(percentOf(acc.treated, acc.cases), 1),
    cfr_pct: round(caseFatalityRate(acc.deaths, acc.cases), 3),
    months_with_reports: periods,
  };
}

export async function malariaStats(input: StatsInput) {
  const sql = getSql();
  const bounds = await dataBounds(sql);
  const yearTo = Math.min(input.yearTo ?? bounds.last_year, bounds.last_year);
  const yearFrom = Math.max(input.yearFrom ?? yearTo, bounds.first_year);
  const index = await getAreaIndex(sql);
  const area = input.area ? resolveArea(index, input.area, input.level) : null;
  if (input.area && !area) {
    return { error: `No area called "${input.area}" was found in the MIS data.`, divisions: index.divisions };
  }

  const filter = areaFilter(sql, area);
  const monthFilter = input.months?.length ? sql`AND report_month IN ${sql(input.months)}` : sql``;

  const rows = await sql<RawRow[]>`
    SELECT division_name, district_name, upazila_name, report_year, report_month,
           ${sql.unsafe(NUMERIC_FIELDS.map((f) => `sum(${f.column})::int AS ${f.column}`).join(", "))}
    FROM mis_monthly
    WHERE report_year BETWEEN ${yearFrom} AND ${yearTo} ${filter} ${monthFilter}
    GROUP BY division_name, district_name, upazila_name, report_year, report_month`;

  const groupBy = input.groupBy ?? "none";
  const child: "division" | "district" | "upazila" =
    input.rankLevel && DEPTH[input.rankLevel] > DEPTH[area?.level ?? "national"]
      ? input.rankLevel
      : !area ? "division" : area.level === "division" ? "district" : "upazila";
  const keyOf = (r: RawRow) =>
    groupBy === "year" ? String(r.report_year)
    : groupBy === "month" ? `${r.report_year}-${pad(r.report_month)}`
    : groupBy === "area" ? (child === "division" ? r.division_name : child === "district" ? r.district_name : `${r.upazila_name} (${r.district_name})`)
    : "total";

  const groups = new Map<string, { acc: Record<string, number>; periods: Set<number> }>();
  for (const r of rows) {
    const k = keyOf(r);
    let g = groups.get(k);
    if (!g) {
      g = { acc: Object.fromEntries(NUMERIC_FIELDS.map((f) => [f.key, 0])), periods: new Set() };
      groups.set(k, g);
    }
    for (const f of NUMERIC_FIELDS) g.acc[f.key] += Number(r[f.column]);
    g.periods.add(r.report_year * 100 + r.report_month);
  }

  let out = [...groups].map(([group, g]) => ({ group, ...summarise(g.acc, g.periods.size) }));
  const sortKey = input.sortBy ?? "cases";
  if (groupBy === "area") {
    out = out.sort((a, b) => (b[sortKey] ?? -1) - (a[sortKey] ?? -1) || b.cases - a.cases).slice(0, input.top ?? 15);
  }
  else out.sort((a, b) => a.group.localeCompare(b.group));

  return {
    scope: area?.label ?? "Bangladesh (national)",
    period: `${yearFrom === yearTo ? yearFrom : `${yearFrom}–${yearTo}`}${input.months?.length ? ` (months ${input.months.join(", ")})` : ""}`,
    latest_data_month: periodLabel(bounds.latest),
    group_by: groupBy === "area" ? `area (${child})` : groupBy,
    rows: out,
  };
}

/* ------------------------------ Forecasts ------------------------------ */

export async function getForecast(input: { area?: string; target?: "cases" | "deaths" }) {
  const sql = getSql();
  if (!(await tableExists(sql, "forecast_monthly"))) {
    return { available: false, note: "Forecasts have not been generated yet. Run: python pipeline/forecast.py" };
  }
  const target = input.target ?? "cases";
  let level: Level = "national";
  let areaKey = "bangladesh";
  if (input.area) {
    const area = resolveArea(await getAreaIndex(sql), input.area);
    if (!area || area.level === "upazila") {
      return { available: false, note: "Forecasts exist for Bangladesh, each division and each district (not upazilas)." };
    }
    level = area.level;
    areaKey = canonicalGeoName(area.level === "division" ? area.division : (area.district ?? ""));
  }
  const [points, runs] = await Promise.all([
    sql`SELECT year, month, round(yhat::numeric, 1)::float AS predicted, round(lo80::numeric, 1)::float AS lo80,
               round(hi80::numeric, 1)::float AS hi80, round(lo95::numeric, 1)::float AS lo95, round(hi95::numeric, 1)::float AS hi95
        FROM forecast_monthly WHERE level = ${level} AND area_key = ${areaKey} AND target = ${target}
        ORDER BY year, month`,
    sql`SELECT area_name, model, horizon_months, accuracy_pct, accuracy_3m_pct, wape, mae, mase, backtest_origins, train_start, train_end,
               notes, created_at
        FROM forecast_runs WHERE level = ${level} AND area_key = ${areaKey} AND target = ${target}
        ORDER BY created_at DESC LIMIT 1`,
  ]);
  if (!points.length) return { available: false, note: `No ${target} forecast stored for this area.` };
  return { available: true, level, target, run: runs[0] ?? null, forecast: points };
}

/* ------------------------------ Weather ------------------------------ */

async function weatherDistricts(sql: Sql, areaName?: string, level?: Level) {
  const all = await sql<{ district_name: string; division_name: string }[]>`
    SELECT DISTINCT district_name, division_name FROM weather_district_monthly`;
  if (!areaName) return { label: "Bangladesh (mean of district points)", names: all.map((d) => d.district_name) };
  const key = canonicalGeoName(areaName);
  const byDistrict = () => {
    const match = all.filter((d) => canonicalGeoName(d.district_name) === key);
    return match.length ? { label: `${match[0].district_name} district`, names: match.map((d) => d.district_name) } : null;
  };
  const byDivision = () => {
    const match = all.filter((d) => canonicalGeoName(d.division_name) === key);
    return match.length ? { label: `${match[0].division_name} division`, names: match.map((d) => d.district_name) } : null;
  };
  // Same precedence as resolveArea(): a bare "Chittagong" means the division.
  return level === "district" || level === "upazila" ? (byDistrict() ?? byDivision()) : (byDivision() ?? byDistrict());
}

export async function getWeather(input: { area?: string; level?: Level; yearFrom?: number; yearTo?: number; groupBy?: "month" | "year" }) {
  const sql = getSql();
  if (!(await tableExists(sql, "weather_district_monthly"))) {
    return { available: false, note: "ERA5 weather has not been loaded yet. Run: python pipeline/era5.py" };
  }
  const scope = await weatherDistricts(sql, input.area, input.level);
  if (!scope?.names.length) return { available: false, note: `No weather series for "${input.area}".` };
  const yearTo = input.yearTo ?? new Date().getFullYear();
  const yearFrom = input.yearFrom ?? yearTo;
  const monthly = await sql<
    { year: number; month: number; temp_mean: number; temp_max: number; temp_min: number; precip_mm: number;
      rainy_days: number; rh_mean: number; dewpoint_mean: number; soil_moisture: number; wind_mean: number }[]
  >`
    SELECT year, month, avg(temp_mean)::float AS temp_mean, avg(temp_max)::float AS temp_max, avg(temp_min)::float AS temp_min,
           avg(precip_mm)::float AS precip_mm, avg(rainy_days)::float AS rainy_days, avg(rh_mean)::float AS rh_mean,
           avg(dewpoint_mean)::float AS dewpoint_mean, avg(soil_moisture)::float AS soil_moisture, avg(wind_mean)::float AS wind_mean
    FROM weather_district_monthly
    WHERE district_name IN ${sql(scope.names)} AND year BETWEEN ${yearFrom} AND ${yearTo}
    GROUP BY year, month ORDER BY year, month`;
  const fmt = (r: (typeof monthly)[number]) => ({
    temp_mean_c: round(r.temp_mean, 1), temp_max_c: round(r.temp_max, 1), temp_min_c: round(r.temp_min, 1),
    rainfall_mm: round(r.precip_mm, 0), rainy_days: round(r.rainy_days, 0), humidity_pct: round(r.rh_mean, 0),
    dew_point_c: round(r.dewpoint_mean, 1), soil_moisture_m3m3: round(r.soil_moisture, 3), wind_kmh: round(r.wind_mean, 1),
  });
  if ((input.groupBy ?? "month") === "month") {
    return { available: true, source: "ERA5 reanalysis via Open-Meteo", scope: scope.label, rows: monthly.map((r) => ({ period: `${r.year}-${pad(r.month)}`, ...fmt(r) })) };
  }
  const years = new Map<number, (typeof monthly)[number][]>();
  for (const r of monthly) years.set(r.year, [...(years.get(r.year) ?? []), r]);
  return {
    available: true,
    source: "ERA5 reanalysis via Open-Meteo",
    scope: scope.label,
    rows: [...years].map(([year, ms]) => ({
      year,
      months: ms.length,
      temp_mean_c: round(ms.reduce((s, m) => s + m.temp_mean, 0) / ms.length, 1),
      rainfall_mm_total: round(ms.reduce((s, m) => s + m.precip_mm, 0), 0),
      humidity_pct: round(ms.reduce((s, m) => s + m.rh_mean, 0) / ms.length, 0),
    })),
  };
}

/* ------------------------------ Climate ↔ malaria ------------------------------ */

function ranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

function spearman(a: number[], b: number[]): number | null {
  if (a.length < 12) return null;
  const ra = ranks(a), rb = ranks(b);
  const mean = (a.length + 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (ra[i] - mean) * (rb[i] - mean);
    da += (ra[i] - mean) ** 2;
    db += (rb[i] - mean) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

/** Spearman correlation of monthly cases with weather 0–3 months earlier. */
export async function climateCorrelation(input: { area?: string; level?: Level; yearFrom?: number }) {
  const sql = getSql();
  if (!(await tableExists(sql, "weather_district_monthly"))) {
    return { available: false, note: "ERA5 weather has not been loaded yet." };
  }
  const bounds = await dataBounds(sql);
  const yearFrom = input.yearFrom ?? bounds.last_year - 7;
  const stats = await malariaStats({ area: input.area, level: input.level, yearFrom, yearTo: bounds.last_year, groupBy: "month" });
  if ("error" in stats) return stats;
  const weather = await getWeather({ area: input.area, level: input.level, yearFrom: yearFrom - 1, yearTo: bounds.last_year, groupBy: "month" });
  const weatherRows = weather.available && "rows" in weather ? weather.rows : undefined;
  if (!weatherRows) return weather;

  const cases = new Map(stats.rows.map((r) => [r.group, r.cases]));
  const wx = new Map(weatherRows.map((r) => ["period" in r ? r.period : "", r]));
  const shift = (period: string, lag: number) => {
    const [y, m] = period.split("-").map(Number);
    const t = y * 12 + m - 1 - lag;
    return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
  };
  const variables = ["rainfall_mm", "temp_mean_c", "humidity_pct", "dew_point_c", "soil_moisture_m3m3"] as const;
  const results = [];
  for (const variable of variables) {
    for (let lag = 0; lag <= 3; lag++) {
      const xs: number[] = [], ys: number[] = [];
      for (const [period, c] of cases) {
        const w = wx.get(shift(period, lag)) as Record<string, number | null> | undefined;
        const v = w?.[variable];
        if (typeof v === "number") { xs.push(v); ys.push(c); }
      }
      results.push({ variable, lag_months: lag, spearman_rho: round(spearman(xs, ys), 2), months: xs.length });
    }
  }
  const strongest = [...results].filter((r) => r.spearman_rho !== null).sort((a, b) => Math.abs(b.spearman_rho!) - Math.abs(a.spearman_rho!))[0];
  return {
    available: true,
    scope: stats.scope,
    period: `${yearFrom}–${bounds.last_year}`,
    method: "Spearman rank correlation between monthly confirmed cases and weather lagged 0–3 months (association, not causation).",
    strongest,
    results,
  };
}

/* ------------------------------ Alerts & overview ------------------------------ */

export async function recentAlerts(input: { limit?: number }) {
  const sql = getSql();
  if (!(await tableExists(sql, "alerts"))) return { alerts: [] };
  const alerts = await sql`
    SELECT kind, level, division_name, district_name, upazila_name, report_year, report_month, observed,
           round(expected::numeric, 1)::float AS expected, round(excess::numeric, 1)::float AS excess, status, created_at
    FROM alerts ORDER BY report_year DESC, report_month DESC, created_at DESC LIMIT ${Math.min(input.limit ?? 20, 100)}`;
  return {
    rules: "Every reported death in the latest 3 months; surges = district/upazila monthly cases > median of the same month in the previous 3 years + 50.",
    alerts,
  };
}

export async function dataOverview() {
  const sql = getSql();
  const bounds = await dataBounds(sql);
  const latestP = Math.floor(bounds.latest / 100) * 12 + (bounds.latest % 100) - 1;
  const [windows] = await sql<{ cases_12m: number; cases_prev_12m: number; deaths_12m: number; tests_12m: number; upazilas_12m: number }[]>`
    SELECT
      coalesce(sum(cases) FILTER (WHERE p > ${latestP - 12}), 0)::int AS cases_12m,
      coalesce(sum(cases) FILTER (WHERE p <= ${latestP - 12} AND p > ${latestP - 24}), 0)::int AS cases_prev_12m,
      coalesce(sum(deaths) FILTER (WHERE p > ${latestP - 12}), 0)::int AS deaths_12m,
      coalesce(sum(tests) FILTER (WHERE p > ${latestP - 12}), 0)::int AS tests_12m,
      count(DISTINCT upazila_id) FILTER (WHERE p > ${latestP - 12} AND cases > 0)::int AS upazilas_12m
    FROM (SELECT *, report_year * 12 + report_month - 1 AS p FROM mis_monthly) m`;
  const top = await sql`
    SELECT district_name, division_name, sum(cases)::int AS cases, sum(deaths)::int AS deaths
    FROM mis_monthly WHERE report_year * 12 + report_month - 1 > ${latestP - 12}
    GROUP BY 1, 2 ORDER BY cases DESC LIMIT 8`;
  const [hasWeather, hasForecast, hasAlerts] = await Promise.all([
    tableExists(sql, "weather_district_monthly"),
    tableExists(sql, "forecast_runs"),
    tableExists(sql, "alerts"),
  ]);
  const weather = hasWeather
    ? (await sql`SELECT count(DISTINCT district_name)::int AS districts, min(year)::int AS first_year, max(year * 100 + month)::int AS latest FROM weather_district_monthly`)[0]
    : null;
  const forecast = hasForecast
    ? await sql`SELECT DISTINCT ON (target) target, model, accuracy_pct, horizon_months, created_at FROM forecast_runs WHERE level = 'national' ORDER BY target, created_at DESC`
    : [];
  const [sync] = await sql`SELECT finished_at FROM mis_sync_log WHERE status = 'success' ORDER BY id DESC LIMIT 1`;
  return {
    data_years: `${bounds.first_year}–${bounds.last_year}`,
    latest_data_month: periodLabel(bounds.latest),
    last_12_months: {
      confirmed_cases: windows.cases_12m,
      previous_12_months_cases: windows.cases_prev_12m,
      change_pct: round(percentOf(windows.cases_12m - windows.cases_prev_12m, windows.cases_prev_12m), 1),
      deaths: windows.deaths_12m,
      tests: windows.tests_12m,
      tpr_pct: round(testPositivityRate(windows.cases_12m, windows.tests_12m)),
      upazilas_with_cases: windows.upazilas_12m,
    },
    top_districts_last_12_months: top,
    population_denominators: "Not loaded — API and ABER cannot be computed until upazila_population is filled.",
    weather_coverage: weather,
    forecasts: forecast,
    alerts_table: hasAlerts,
    last_successful_sync: sync?.finished_at ?? null,
  };
}
