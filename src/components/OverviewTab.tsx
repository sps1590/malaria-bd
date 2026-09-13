"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MODEL_LABEL, SERIES, STATUS, fmtInt, fmtNum } from "@/lib/chart-theme";
import { MONTHS } from "@/lib/malaria-metrics";

interface ForecastRun {
  model: string;
  accuracy_pct: number | null;
  accuracy_3m_pct: number | null;
  notes: string;
  backtest_origins: number;
}
interface ForecastPoint {
  year: number;
  month: number;
  predicted: number;
  lo80: number;
  hi80: number;
}
type ForecastResult = { available: false; note: string } | { available: true; run: ForecastRun | null; forecast: ForecastPoint[] };

interface OverviewResponse {
  overview: {
    data_years: string;
    latest_data_month: string;
    last_12_months: {
      confirmed_cases: number;
      previous_12_months_cases: number;
      change_pct: number | null;
      deaths: number;
      tests: number;
      tpr_pct: number | null;
      upazilas_with_cases: number;
    };
    top_districts_last_12_months: { district_name: string; division_name: string; cases: number; deaths: number }[];
    population_denominators: string;
    weather_coverage: { districts: number; first_year: number; latest: number } | null;
    last_successful_sync: string | null;
  };
  forecast: { cases: ForecastResult; deaths: ForecastResult };
  alerts: { kind: string; level: string; district_name: string; upazila_name: string | null; report_year: number; report_month: number; observed: number; expected: number | null }[];
  error?: string;
}

export default function OverviewTab() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/insights/overview")
      .then((r) => r.json() as Promise<OverviewResponse>)
      .then((j) => (j.error ? setError(j.error) : setData(j)))
      .catch(() => setError("Failed to load the overview."));
  }, []);

  if (error) return <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>;
  if (!data) return <p className="text-sm text-slate-500">Loading command center…</p>;

  const o = data.overview;
  const w = o.last_12_months;
  const cases = data.forecast.cases;
  const deaths = data.forecast.deaths;
  const nextCases = cases.available ? cases.forecast[0] : null;
  const nextDeaths = deaths.available ? deaths.forecast[0] : null;
  const maxDistrict = Math.max(1, ...o.top_districts_last_12_months.map((d) => d.cases));
  const decreasing = (w.change_pct ?? 0) < 0;

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 p-6 text-white shadow-lg">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-indigo-300">Malaria situation · Bangladesh</p>
            <h2 className="mt-1 text-2xl font-bold">Last 12 months to {o.latest_data_month}</h2>
            <p className="mt-1 text-sm text-slate-300">
              Surveillance {o.data_years} · ERA5 climate for {o.weather_coverage?.districts ?? 0} districts · last sync{" "}
              {o.last_successful_sync ? new Date(o.last_successful_sync).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" }) : "never"}
            </p>
          </div>
          <div className="flex gap-2 text-xs">
            <Link href="?tab=ai" className="rounded-full bg-white/10 px-3 py-1.5 hover:bg-white/20">Ask the AI analyst →</Link>
            <Link href="?tab=forecast" className="rounded-full bg-white/10 px-3 py-1.5 hover:bg-white/20">Forecasts →</Link>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <HeroTile label="Confirmed cases" value={fmtInt(w.confirmed_cases)}
            detail={w.change_pct === null ? "no previous year" : `${decreasing ? "▼" : "▲"} ${fmtNum(Math.abs(w.change_pct))}% vs previous 12 months`}
            detailClass={decreasing ? "text-emerald-300" : "text-rose-300"} />
          <HeroTile label="Deaths" value={fmtInt(w.deaths)} detail="reported in the last 12 months" />
          <HeroTile label="Test positivity" value={`${fmtNum(w.tpr_pct, 2)}%`} detail={`${fmtInt(w.tests)} people tested`} />
          <HeroTile label="Upazilas with cases" value={fmtInt(w.upazilas_with_cases)} detail="reporting units with ≥1 case" />
          <HeroTile
            label={nextCases ? `Forecast · ${MONTHS[nextCases.month - 1]} ${nextCases.year}` : "Forecast"}
            value={nextCases ? `~${fmtInt(nextCases.predicted)}` : "—"}
            detail={nextCases ? `cases (80% range ${fmtInt(nextCases.lo80)}–${fmtInt(nextCases.hi80)})` : "run the forecast pipeline"}
          />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Forecast model">
          {cases.available && cases.run ? (
            <div className="space-y-2 text-sm">
              <p className="font-semibold text-slate-800">{MODEL_LABEL[cases.run.model] ?? cases.run.model}</p>
              <div className="flex gap-4">
                <div><div className="text-2xl font-bold text-slate-900">{cases.run.accuracy_pct ?? "—"}%</div><div className="text-xs text-slate-500">1-month-ahead accuracy</div></div>
                <div><div className="text-2xl font-bold text-slate-900">{cases.run.accuracy_3m_pct ?? "—"}%</div><div className="text-xs text-slate-500">3-months-ahead</div></div>
              </div>
              <p className="text-xs text-slate-500">Measured on {cases.run.backtest_origins} rolling back-tests (100 × (1 − WAPE)); not a target, the real score.</p>
              {nextDeaths && (
                <p className="text-xs text-slate-600">
                  Expected deaths next month: <b>{fmtNum(nextDeaths.predicted, 1)}</b> (80% range {fmtInt(nextDeaths.lo80)}–{fmtInt(nextDeaths.hi80)})
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500">{"note" in cases ? cases.note : "No forecast yet."}</p>
          )}
        </Card>

        <Card title="Top districts · last 12 months">
          <ul className="space-y-1.5">
            {o.top_districts_last_12_months.map((d) => (
              <li key={d.district_name} className="text-sm">
                <div className="flex justify-between gap-2">
                  <span className="truncate text-slate-700">{d.district_name}</span>
                  <span className="tabular-nums text-slate-900">{fmtInt(d.cases)}{d.deaths ? <span className="ml-1 text-xs text-slate-500">· {d.deaths} deaths</span> : null}</span>
                </div>
                <div className="mt-0.5 h-1.5 rounded-full bg-slate-100">
                  <div className="h-1.5 rounded-full" style={{ width: `${(d.cases / maxDistrict) * 100}%`, background: SERIES[0] }} />
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Latest alerts" action={<Link href="?tab=alerts" className="text-xs text-indigo-700 hover:underline">All alerts →</Link>}>
          {data.alerts.length === 0 ? (
            <p className="text-sm text-slate-500">No alerts recorded.</p>
          ) : (
            <ul className="space-y-2">
              {data.alerts.map((a, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: a.kind === "death" ? STATUS.critical : STATUS.serious }} />
                  <span className="text-slate-700">
                    <b>{a.kind === "death" ? `Death ×${a.observed}` : `Surge: ${fmtInt(a.observed)} cases`}</b> — {a.upazila_name ?? a.district_name}
                    {a.upazila_name ? `, ${a.district_name}` : ""} · {MONTHS[a.report_month - 1].slice(0, 3)} {a.report_year}
                    {a.kind === "surge" && a.expected !== null ? <span className="text-slate-500"> (usual ~{fmtInt(a.expected)})</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        {[
          { tab: "epi", title: "Epidemiology", text: "Endemic channel, epidemic threshold, species, age & sex, detection, hotspots" },
          { tab: "bi", title: "BI & GIS map", text: "Drag-and-drop dashboard and Division → District → Upazila map" },
          { tab: "pivot", title: "Pivot analysis", text: "Cross-tabulate any indicator; export Excel/PDF" },
          { tab: "forecast", title: "Forecast & climate", text: "Model forecasts with measured accuracy and ERA5 weather links" },
        ].map((c) => (
          <Link key={c.tab} href={`?tab=${c.tab}`} className="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-indigo-300 hover:shadow">
            <div className="text-sm font-semibold text-slate-800">{c.title} →</div>
            <p className="mt-1 text-xs text-slate-500">{c.text}</p>
          </Link>
        ))}
      </div>

      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{o.population_denominators}</p>
    </div>
  );
}

function HeroTile({ label, value, detail, detailClass = "text-slate-400" }: { label: string; value: string; detail: string; detailClass?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur">
      <div className="text-[11px] font-medium uppercase tracking-wide text-indigo-200">{label}</div>
      <div className="mt-1 text-3xl font-bold">{value}</div>
      <div className={`mt-0.5 text-xs ${detailClass}`}>{detail}</div>
    </div>
  );
}

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
