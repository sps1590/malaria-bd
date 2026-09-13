import type { Metadata } from "next";
import Link from "next/link";
import AlertsTab from "@/components/AlertsTab";
import AnalystChat from "@/components/AnalystChat";
import BiTab from "@/components/BiTab";
import EpiTab from "@/components/EpiTab";
import ForecastTab from "@/components/ForecastTab";
import OverviewTab from "@/components/OverviewTab";
import PivotTab from "@/components/PivotTab";
import { getSql } from "@/lib/db";
import { NUMERIC_FIELDS, type AreaTuple, type MisDataset, type RowTuple } from "@/lib/malaria-metrics";

export const metadata: Metadata = {
  title: "Malaria MIS Analytics",
  description: "Bangladesh malaria data warehouse — surveillance, forecasting, climate, GIS, alerts and AI analyst",
};

type Tab = "overview" | "pivot" | "bi" | "forecast" | "epi" | "alerts" | "ai";
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Command Center" },
  { id: "epi", label: "Epidemiology" },
  { id: "forecast", label: "Forecast & Climate" },
  { id: "bi", label: "BI & GIS Map" },
  { id: "pivot", label: "Pivot Analysis" },
  { id: "alerts", label: "Alerts" },
  { id: "ai", label: "AI Analyst" },
];
/** Tabs that work on the in-browser dataset for the selected year range. */
const DATA_TABS = new Set<Tab>(["pivot", "bi", "epi"]);
const DEFAULT_SPAN_YEARS = 5;

type DbRow = {
  upazila_id: number;
  report_year: number;
  report_month: number;
  population: number | null;
} & Record<string, number | string | Date | null>;

type DbArea = {
  upazila_id: number;
  upazila_name: string;
  district_id: number;
  district_name: string;
  division_name: string;
};

async function loadDataset(from: number, to: number): Promise<MisDataset> {
  const sql = getSql();
  const [rows, areas, years, lastSync] = await Promise.all([
    // Nearest available population year is used as the API/ABER denominator.
    sql<DbRow[]>`
      SELECT m.*, pop.population
      FROM mis_monthly m
      LEFT JOIN LATERAL (
        SELECT p.population
        FROM upazila_population p
        WHERE p.upazila_id = m.upazila_id
        ORDER BY abs(p.year - m.report_year), p.year DESC
        LIMIT 1
      ) pop ON true
      WHERE m.report_year BETWEEN ${from} AND ${to}
      ORDER BY m.report_year, m.report_month, m.upazila_id`,
    sql<DbArea[]>`
      SELECT DISTINCT ON (upazila_id) upazila_id, upazila_name, district_id, district_name, division_name
      FROM mis_monthly
      ORDER BY upazila_id, report_year DESC, report_month DESC`,
    sql<{ report_year: number }[]>`SELECT DISTINCT report_year FROM mis_monthly ORDER BY report_year`,
    sql<{ finished_at: Date }[]>`
      SELECT finished_at FROM mis_sync_log WHERE status = 'success' ORDER BY id DESC LIMIT 1`,
  ]);

  return {
    areas: areas.map((a): AreaTuple => [a.upazila_id, a.upazila_name, a.district_id, a.district_name, a.division_name]),
    rows: rows.map((r): RowTuple => [
      r.upazila_id,
      r.report_year,
      r.report_month,
      r.population == null ? null : Number(r.population),
      ...NUMERIC_FIELDS.map((f) => Number(r[f.column] ?? 0)),
    ]),
    years: years.map((y) => y.report_year),
    syncedAt: lastSync[0]?.finished_at ? new Date(lastSync[0].finished_at).toISOString() : null,
  };
}

function parseYear(raw: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : null;
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const tab: Tab = TABS.some((t) => t.id === params.tab) ? (params.tab as Tab) : "overview";
  const needsData = DATA_TABS.has(tab);
  const toParam = parseYear(params.to) ?? new Date().getFullYear();
  const fromParam = parseYear(params.from) ?? toParam - (DEFAULT_SPAN_YEARS - 1);
  const from = Math.min(fromParam, toParam);
  const to = Math.max(fromParam, toParam);

  let dataset: MisDataset | null = null;
  let loadError: string | null = null;
  if (needsData) {
    try {
      dataset = await loadDataset(from, to);
    } catch (err) {
      loadError = err instanceof Error ? err.message : "Failed to load MIS data.";
    }
  }

  const yearOptions = [...new Set([...(dataset?.years ?? []), ...range(from, to)])].sort((a, b) => a - b);

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <header className="bg-gradient-to-r from-slate-950 via-indigo-950 to-slate-950 text-white">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-end justify-between gap-4 px-6 pt-4">
          <div className="flex items-center gap-3">
            <div aria-hidden className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-rose-500 to-indigo-500 text-lg font-black">M</div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Malaria MIS Analytics · Bangladesh</h1>
              <p className="text-xs text-indigo-200">NMCP LMIS data warehouse · ERA5 climate · forecasting · GIS · alerts · AI analyst</p>
            </div>
          </div>

          {needsData && (
            <form method="get" className="flex items-end gap-2 text-sm">
              <input type="hidden" name="tab" value={tab} />
              {(["from", "to"] as const).map((name) => (
                <label key={name} className="flex flex-col text-xs font-medium text-indigo-200">
                  {name === "from" ? "From" : "To"}
                  <select name={name} defaultValue={name === "from" ? from : to} className="mt-1 rounded border border-white/20 bg-slate-900 px-2 py-1.5 text-sm text-white">
                    {yearOptions.map((y) => (
                      <option key={y} value={y}>{y}</option>
                    ))}
                  </select>
                </label>
              ))}
              <button type="submit" className="rounded bg-indigo-500 px-3 py-1.5 font-medium text-white hover:bg-indigo-400">Apply</button>
            </form>
          )}
        </div>

        <nav className="mx-auto mt-3 flex max-w-[1600px] gap-1 overflow-x-auto px-6" aria-label="Views">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={{ query: DATA_TABS.has(t.id) ? { tab: t.id, from, to } : { tab: t.id } }}
              aria-current={tab === t.id ? "page" : undefined}
              className={`whitespace-nowrap rounded-t-lg px-4 py-2 text-sm font-medium ${
                tab === t.id ? "bg-slate-100 text-slate-900" : "text-indigo-200 hover:bg-white/10 hover:text-white"
              }`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </header>

      <section className="mx-auto max-w-[1600px] px-6 py-5">
        {loadError ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <p className="font-semibold">Could not load data.</p>
            <p className="mt-1">{loadError}</p>
            <p className="mt-2 text-red-700">
              First run? Call <code>/api/cron/sync-mis</code> (with <code>Authorization: Bearer $CRON_SECRET</code>) to create tables and import data.
            </p>
          </div>
        ) : tab === "overview" ? (
          <OverviewTab />
        ) : tab === "forecast" ? (
          <ForecastTab />
        ) : tab === "alerts" ? (
          <AlertsTab />
        ) : tab === "ai" ? (
          <AnalystChat />
        ) : !dataset || dataset.rows.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">No records for {from}–{to}.</div>
        ) : tab === "pivot" ? (
          <PivotTab key={`${from}-${to}`} dataset={dataset} />
        ) : tab === "epi" ? (
          <EpiTab key={`${from}-${to}`} dataset={dataset} />
        ) : (
          <BiTab key={`${from}-${to}`} dataset={dataset} />
        )}
      </section>
    </main>
  );
}
