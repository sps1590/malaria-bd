# Malaria MIS Analytics — Bangladesh

A malaria data warehouse and decision dashboard for Bangladesh's National Malaria Elimination
Programme, built on the NMCP LMIS feed (`https://lmis.nmcp.gov.bd/admin/mis-api-data`).

Next.js 16 (App Router, React 19, TypeScript, Tailwind v4) · PostgreSQL · Python forecasting pipeline.

## What's inside

| Tab | What it gives you |
| --- | --- |
| **Command Center** | Last-12-month cases (with change), deaths, test positivity, active upazilas, next-month forecast, top districts, latest alerts |
| **Epidemiology** | A malaria situation-analysis report for Bangladesh, a division, a district or the 13 endemic districts: auto-written **key findings** and KPI strip with sparklines; **Time** — epidemic curve with 12-month moving average, WHO endemic channel, cumulative year-to-date vs earlier years, same-season **outbreak signal index** (EARS-style) with a district signal table, calendar heat map, seasonality and species seasonality, annual indicator table; **Place** — sortable district/upazila league table (cases, trend, API/TPR/ABER, persistence, signal, elimination status, CSV), highest-burden upazilas, Lorenz curve/Gini, API risk strata over time, elimination-progress status and longest-silent areas; **People** — species, age and sex profile, pregnancy; **Clinical** — case-management cascade, severe share, deaths and CFR; **Surveillance quality** — testing effort and TPR, ABER-vs-TPR adequacy scatter, reporting completeness, active vs passive detection, LLIN distribution; plus a methods/definitions section. Opens on the full 2012→today history |
| **Forecast & Climate** | 18-month case and death forecasts with 80%/95% ranges, back-test vs actual, the selected model and its **measured** accuracy, full model comparison, live tracking of past forecasts against real data, ERA5 climate panels and lagged climate–malaria correlations |
| **BI & GIS Map** | Drag-and-drop dashboard; every panel opens larger with Division → District → Upazila drill-down and downloads as PNG; cases/deaths/tests with forecast; map red means **> 1,000 cases** for divisions, **> 500** for districts, **> 200** for upazilas (0 cases ash-grey) |
| **Pivot Analysis** | One-line field bar for Rows / Columns / Values — click "+ Add" to pop a list of the fields not already used elsewhere (a field picked for one disappears from the other two); *any* field works in *any* of the three, including measures (a measure placed in Rows/Columns groups by that record's own value) and places/time placed as a Value (counted as a distinct count); multiple nested fields per zone, an optional **Filters** zone (like Excel's — add any field, then tick the values to keep; leave it empty for no filter), a **Hide total columns** checkbox (drops the Grand-total column(s) while keeping each column's data), Division selector plus a multi-select **District** picker (default *All districts*; one tick for **Endemic Districts** = the 13 at-risk districts, or any of the 64 by name, combinable), a **Cases ≥ 1 only** checkbox that hides result rows with no confirmed cases, month date-range filter, virtualized grid, `.xlsx`/`.pdf` export (both honour the filters and the hidden totals). **View as** Table / Column / Bar / Stacked / Line / Area / Pie / Map — charts plot one chosen measure (rows = categories, columns = series, top-N rows), the map colours districts/divisions/upazilas by it. Downloads follow the view: **PNG** of the chart/map, **PDF** with the picture on page 1 then the table, **.xlsx** with the Pivot sheet plus a "Chart data"/"Map data" sheet of exactly what is plotted |
| **Alerts** | Every reported death and every sudden surge (district/upazila cases > usual pattern + 50), email preview, delivery status |
| **AI Analyst** | A free, read-only chat analyst: ask in plain words and it writes and runs the database queries for you, then answers with a narrative, a table, an auto-chosen chart, the exact SQL ("How I got this") and CSV download. **Maps on request:** "make a map of cases in Bandarban", "upazila map of test positivity for the endemic districts", "map of deaths by district in 2025" draw a Leaflet choropleth zoomed to the region you name (any division, district, the 13 endemic districts or all Bangladesh, at division/district/upazila level, for any measure and period), with a legend and PNG download. Counts, rates and trends for any area and period; rankings with conditions ("districts with more than 100 cases"); comparisons and "which areas increased the most"; **why-analysis** of a change; unusual-rise detection; forecasts, weather, climate links, alerts, NSP targets; malaria definitions. Follow-ups work ("and deaths?", "what about Sylhet?"). Needs no API key and no paid service |

Every table and chart on every tab — not just BI & GIS Map — can be downloaded as a PNG and opened
larger in a full-screen view. The header shows a live clock in the viewer's own local time zone plus
current temperature/rainfall/precipitation chance/humidity for Dhaka, and a "Developed by: Md.
Shahriar Parvez | MIS/IT Expert | NMEP" credit is shown in an amber badge top-right of the header and
bottom-right of the page footer, and stamped into every exported PNG/`.xlsx`/`.pdf`.

### Keeping data up to date

- **Sync now** button (header strip on every tab) pulls the latest NMEP MIS feed on demand via `POST /api/sync`
  and reloads the page when new records arrive. The strip also shows the newest data month and when it was last synced.
- The page **syncs itself automatically** when the last successful sync is more than 6 hours old (checked on load and
  every 30 minutes while a tab stays open).
- `POST /api/sync` needs no secret but takes no input and is throttled (one sync per 2 minutes, never two at once), so
  it can't be used to hammer the MIS server or the database. The daily cron (`/api/cron/sync-mis`) still requires
  `CRON_SECRET`; both share the code in `src/lib/mis-sync.ts`.
- ERA5 weather and forecasts are refreshed by the Python pipeline (see below), not by the button.

### Data flow (daily)

1. **09:00 BST** — Vercel Cron calls `/api/cron/sync-mis`: fetch → Zod validation → idempotent upsert → alert detection → one email digest.
2. **09:30 BST** — GitHub Actions (`.github/workflows/data-pipeline.yml`) refreshes ERA5 weather and retrains every forecast.

### Forecasting — honest accuracy

`pipeline/forecast.py` makes seasonal naive, exponential smoothing, SARIMA, SARIMAX + ERA5, LightGBM
(with and without ERA5) and an ensemble compete in a rolling-origin back-test (each forecast uses only data
available at that time). The best model per area is kept and its real score is shown:
**accuracy = 100 × (1 − WAPE)** at 1 and 3 months ahead. Nothing is tuned to hit a target number.
Deaths are rare, so they are shown as expected counts with Poisson ranges and a mean absolute error.

Every forecast is archived with the data month it was made from (`forecast_archive`). When the MIS later
reports those months, the Forecast tab shows the real error of those earlier forecasts, and each daily retrain
re-tests every model on the newest data and switches to whichever is now most accurate.

### Alert rules

- **Death:** any death reported in the latest 3 reporting months (each alerted once).
- **Surge:** a district or upazila whose monthly confirmed cases exceed the median of the same month in the
  previous 3 years by more than 50.
- The very first run records existing alerts without emailing (no backlog flood).

## Run locally (Windows, no Docker needed)

```bash
npm install
```

```bash
python -m pip install -r pipeline/requirements.txt
```

Copy `.env.example` to `.env.local` and set `CRON_SECRET`. Then, in separate terminals:

```bash
npm run db:local
```

```bash
npm run dev
```

Load data, weather and forecasts (first time):

```bash
npm run sync
```

```bash
python pipeline/era5.py
```

```bash
python pipeline/forecast.py
```

The ERA5 backfill (2012 → today, 64 districts) uses Open-Meteo's free tier; it loads malaria-burden
districts first and stops politely when the free quota is used up — just run it again later.

## Population & National Strategic Plan targets

Import the NSP quantification workbook (population + targets) — re-run whenever a new version arrives:

```bash
python pipeline/import_quantification.py "C:/path/NSP-BAN quantification_19042026_SV2 (1).xlsx"
```

- Every relevant sheet (Census 2022 upazila population, district projections 2019–2035, FDMN population,
  NSP projected cases/API/deaths, ABER and testing targets, ITN and commodity requirements, foci population,
  case origin, unit costs) is stored in `population_quantification` together with the **file name**.
- `upazila_population` is derived from it: each of the 77 at-risk upazilas is matched to its MIS reporting unit
  (new upazilas such as Eidgaon, Guimara and Madhyanagar are added to the unit that reports for them), projected
  2012–2035 with the workbook's district growth; hospital/CS-office units get 0 so their cases still count for
  their district.
- Used in: API and ABER everywhere (Pivot, BI, Epidemiology), the Command Center population & NSP card, the
  Forecast tab's “NSP targets vs actual and forecast” section, and the AI analyst. Each place names the source file.

## Optional features

- **AI analyst — free, no key, read-only.** It is a language-understanding engine that runs on your own
  database (`src/lib/analyst/`), not a paid model: `nlu.ts` turns a question (plus the previous turn, for
  follow-ups) into a structured request — measures, places incl. spelling variants and typos, period,
  grouping, ranking, thresholds, comparison — `query.ts` builds a parameterised SELECT from a fixed catalogue
  of whitelisted SQL expressions (`catalog.ts`; no user text is ever concatenated into SQL), and `stats.ts` /
  `handlers.ts` write the answer. **It can never change data:** every query runs inside a Postgres
  `READ ONLY` transaction with a 10-second timeout, requests to delete/update/insert are refused, and raw SQL
  typed into the chat is not executed. Run `npm run verify:readonly` to prove the database rejects
  DELETE/UPDATE/INSERT/DROP/CREATE/TRUNCATE in that mode. Limits: it understands the questions its
  vocabulary covers (see the starter prompts and "What can you do?"); something outside that gets a "not
  understood" with suggestions rather than a guess, and a place name it does not know is never silently
  replaced by a national answer. Rates ranked across areas ignore areas with too few tests/cases (< 100 tests,
  < 20 cases) because such rates are unreliable.
- **Email alerts:** follow the steps on the Alerts tab (Gmail App Password → `GMAIL_USER`,
  `GMAIL_APP_PASSWORD`, `ALERT_EMAIL_TO`).
- **API and ABER:** come from the imported population workbook (see above).

## Deploy (live: https://malaria-bd.vercel.app)

1. Vercel project `malaria-bd` (region `sin1`) with a Neon database `malaria-bd-db` (Singapore) connected — it
   provides `DATABASE_URL`.
2. Add `CRON_SECRET` in Vercel → Settings → Environment Variables, redeploy, then run the cron job once from
   Vercel → Settings → Cron Jobs → Run (creates tables and loads MIS data).
3. Put the production `DATABASE_URL` in `.env.production.local` (never committed) and copy the locally prepared
   population, weather and forecast tables:

```bash
python pipeline/copy_to_production.py
```

4. In GitHub → Settings → Secrets and variables → Actions, add `DATABASE_URL` (production value) so the daily
   weather/forecast pipeline keeps production up to date.

## Warehouse tables

| Table | Grain / purpose |
| --- | --- |
| `mis_monthly` | Fact table — upazila × month surveillance counts |
| `population_quantification` | Population and NSP quantification workbook, long format with source file name |
| `upazila_population` | Denominators for API / ABER, derived from the population workbook |
| `weather_district_monthly` | ERA5 monthly climate per district |
| `forecast_runs`, `forecast_monthly`, `forecast_backtest` | Model runs with accuracy, forecasts, back-test predictions |
| `forecast_archive` | Every forecast by data vintage, for live accuracy against later real data |
| `alerts` | Death and surge alerts with email status |
| `mis_sync_log` | Every sync with counts and errors |

## Data sources & licences

- Malaria surveillance: National Malaria Elimination Programme (NMEP/NMCP), Bangladesh LMIS.
- Climate: ERA5 reanalysis (ECMWF / Copernicus Climate Change Service) via the Open-Meteo archive API.
- Boundaries: [geoBoundaries](https://www.geoboundaries.org) gbOpen BGD — ADM1 CC0 1.0; ADM2/ADM3 CC BY 3.0 IGO.
- Basemap: © OpenStreetMap contributors.
