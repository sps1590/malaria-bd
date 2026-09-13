/**
 * Population at risk and National Strategic Plan (NSP) targets, from the imported
 * NSP-BAN quantification workbook (table population_quantification), compared with
 * actual MIS data and the model forecasts.
 */
import { getAreaIndex, resolveArea } from "@/lib/agent-data";
import { getSql, tableExists, type Sql } from "@/lib/db";
import { canonicalGeoName } from "@/lib/malaria-metrics";

const NATIONAL_LABEL = "13 at-risk districts";
const round = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits;

export async function populationSource(sql: Sql = getSql()): Promise<string | null> {
  if (!(await tableExists(sql, "population_quantification"))) return null;
  const [row] = await sql<{ source_file: string }[]>`
    SELECT source_file FROM population_quantification ORDER BY imported_at DESC LIMIT 1`;
  return row?.source_file ?? null;
}

export interface NspYear {
  year: number;
  population: number | null;
  months_reported: number;
  actual_cases: number | null;
  actual_deaths: number | null;
  actual_tests: number | null;
  api_actual: number | null;
  aber_actual_pct: number | null;
  nsp_cases: number | null;
  nsp_api: number | null;
  nsp_deaths: number | null;
  nsp_aber_pct: number | null;
  nsp_tests: number | null;
  forecast_cases: number | null;
  forecast_deaths: number | null;
  expected_cases: number | null;
  expected_deaths: number | null;
}

type QuantRow = { dataset: string; area_level: string; area_label: string; year: number | null; indicator: string; value: number };

/** Per-year NSP targets vs actual vs forecast, for the 13 at-risk districts (NSP national) or one district. */
export async function nspComparison(input: { district?: string } = {}) {
  const sql = getSql();
  const source = await populationSource(sql);
  if (!source) {
    return { available: false as const, note: 'Population & NSP workbook not imported yet. Run: python pipeline/import_quantification.py "<workbook.xlsx>"' };
  }
  const area = input.district ? resolveArea(await getAreaIndex(sql), input.district, "district") : null;
  if (input.district && area?.level !== "district") {
    return { available: false as const, source, note: `NSP targets are set per district and for the 13 at-risk districts; "${input.district}" is not a district.` };
  }
  const districtKey = area?.district ? canonicalGeoName(area.district) : null;

  const quant = await sql<QuantRow[]>`
    SELECT dataset, area_level, area_label, year::int AS year, indicator, value
    FROM population_quantification
    WHERE source_file = ${source}
      AND dataset IN ('district_population', 'nsp_projected_cases', 'nsp_api_target', 'nsp_projected_deaths', 'aber_target', 'test_target')`;
  const scoped = quant.filter((r) =>
    districtKey
      ? r.area_level === "district" && canonicalGeoName(r.area_label) === districtKey
      : r.area_label === NATIONAL_LABEL || (r.dataset === "test_target" && r.area_label.startsWith("Grand Total (64")),
  );
  const series = (dataset: string, indicator: string) =>
    new Map(scoped.filter((r) => r.dataset === dataset && r.indicator === indicator && r.year !== null).map((r) => [r.year as number, r.value]));
  const population = series("district_population", "population");
  const nspCases = series("nsp_projected_cases", "cases");
  const nspApi = series("nsp_api_target", "api");
  const nspDeaths = series("nsp_projected_deaths", "deaths");
  const nspAber = series("aber_target", "aber");
  const nspTests = series("test_target", "tests_total");

  const actual = await sql<
    { year: number; months: number; cases: number; deaths: number; tests: number; cases_cov: number | null; tests_cov: number | null; person_years: number | null }[]
  >`
    SELECT m.report_year::int AS year, count(DISTINCT m.report_month)::int AS months,
           sum(m.cases)::int AS cases, sum(m.deaths)::int AS deaths, sum(m.tests)::int AS tests,
           sum(m.cases) FILTER (WHERE p.upazila_id IS NOT NULL)::float AS cases_cov,
           sum(m.tests) FILTER (WHERE p.upazila_id IS NOT NULL)::float AS tests_cov,
           (sum(p.population) / 12.0)::float AS person_years
    FROM mis_monthly m
    LEFT JOIN upazila_population p ON p.upazila_id = m.upazila_id AND p.year = m.report_year
    WHERE m.report_year >= 2018 ${area?.district ? sql`AND m.district_name = ${area.district}` : sql``}
    GROUP BY 1 ORDER BY 1`;
  const actualByYear = new Map(actual.map((a) => [a.year, a]));

  const forecastRows = (await tableExists(sql, "forecast_monthly"))
    ? await sql<{ target: string; year: number; total: number; months: number }[]>`
        SELECT target, year::int AS year, sum(yhat)::float AS total, count(*)::int AS months FROM forecast_monthly
        WHERE level = ${districtKey ? "district" : "national"} AND area_key = ${districtKey ?? "bangladesh"}
        GROUP BY 1, 2`
    : [];
  const forecast = (target: string) => new Map(forecastRows.filter((f) => f.target === target).map((f) => [f.year, f]));
  const fCases = forecast("cases");
  const fDeaths = forecast("deaths");

  const years = [...new Set([...population.keys(), ...nspCases.keys(), ...actualByYear.keys(), ...fCases.keys()])]
    .filter((y) => y >= 2018 && y <= 2035)
    .sort((a, b) => a - b);
  const rows: NspYear[] = years.map((year) => {
    const a = actualByYear.get(year);
    const py = a?.person_years ?? 0;
    const fc = fCases.get(year)?.total ?? null;
    const fd = fDeaths.get(year)?.total ?? null;
    // Only give a whole-year expectation when reported months + forecast months cover the full year.
    const covered = (a?.months ?? 0) + (fCases.get(year)?.months ?? 0) >= 12;
    return {
      year,
      population: round(population.get(year), 0),
      months_reported: a?.months ?? 0,
      actual_cases: a?.cases ?? null,
      actual_deaths: a?.deaths ?? null,
      actual_tests: a?.tests ?? null,
      api_actual: py > 0 ? round(((a?.cases_cov ?? 0) / py) * 1000, 2) : null,
      aber_actual_pct: py > 0 ? round(((a?.tests_cov ?? 0) / py) * 100, 2) : null,
      nsp_cases: round(nspCases.get(year), 0),
      nsp_api: round(nspApi.get(year), 2),
      nsp_deaths: round(nspDeaths.get(year), 1),
      nsp_aber_pct: nspAber.has(year) ? round((nspAber.get(year) ?? 0) * 100, 1) : null,
      nsp_tests: round(nspTests.get(year), 0),
      forecast_cases: round(fc, 0),
      forecast_deaths: round(fd, 1),
      // Actual months reported so far + the model forecast for the remaining months of that year.
      expected_cases: covered ? round((a?.cases ?? 0) + (fc ?? 0), 0) : null,
      expected_deaths: covered ? round((a?.deaths ?? 0) + (fd ?? 0), 1) : null,
    };
  });

  return {
    available: true as const,
    source,
    scope: area?.district ? `${area.district} district` : "13 at-risk districts (NSP national)",
    notes: {
      population: `Population: BBS Census 2022 upazila population, projected yearly (source: ${source}).`,
      targets: `NSP targets: intensified scenario in ${source} (actual to 2025, projected thereafter).`,
      actual_api: "Actual API/ABER = cases (tests) in upazilas covered by the population file ÷ their population; hospital/CS-office cases in those districts are included.",
      expected: "Expected = cases already reported that year + model forecast for the remaining months (shown only when the whole year is covered).",
    },
    years: rows,
  };
}
