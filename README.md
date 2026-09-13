# Malaria MIS Analytics — Bangladesh

A malaria data warehouse and decision dashboard for Bangladesh's National Malaria Elimination
Programme, built on the NMCP LMIS feed (`https://lmis.nmcp.gov.bd/admin/mis-api-data`).

Next.js 16 (App Router, React 19, TypeScript, Tailwind v4) · PostgreSQL · Python forecasting pipeline.

## What's inside

| Tab | What it gives you |
| --- | --- |
| **Command Center** | Last-12-month cases (with change), deaths, test positivity, active upazilas, next-month forecast, top districts, latest alerts |
| **Epidemiology** | WHO endemic channel with epidemic threshold (mean + 2 SD), species trend, age/sex/pregnancy, active vs passive detection, severity/treatment/referral, reporting completeness, persistent hotspots |
| **Forecast & Climate** | 6-month case and death forecasts with 80%/95% ranges, back-test vs actual, the selected model and its **measured** accuracy, full model comparison, ERA5 climate panels and lagged climate–malaria correlations |
| **BI & GIS Map** | Drag-and-drop dashboard; Division → District → Upazila choropleth (dropdowns, click-to-drill, “Up”); red is reserved for areas with **100+ cases** |
| **Pivot Analysis** | Excel-style cross-tabulation with API/TPR/ABER/CFR, virtualized grid, `.xlsx`/`.pdf` export |
| **Alerts** | Every reported death and every sudden surge (district/upazila cases > usual pattern + 50), email preview, delivery status |
| **AI Analyst** | Chat that answers questions from the warehouse, forecasts, climate data and alerts |

### Data flow (daily)

1. **09:00 BST** — Vercel Cron calls `/api/cron/sync-mis`: fetch → Zod validation → idempotent upsert → alert detection → one email digest.
2. **09:30 BST** — GitHub Actions (`.github/workflows/data-pipeline.yml`) refreshes ERA5 weather and retrains every forecast.

### Forecasting — honest accuracy

`pipeline/forecast.py` makes seasonal naive, exponential smoothing, SARIMA, SARIMAX + ERA5, LightGBM
(with and without ERA5) and an ensemble compete in a rolling-origin back-test (each forecast uses only data
available at that time). The best model per area is kept and its real score is shown:
**accuracy = 100 × (1 − WAPE)** at 1 and 3 months ahead. Nothing is tuned to hit a target number.
Deaths are rare, so they are shown as expected counts with Poisson ranges and a mean absolute error.

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

## Optional features

- **AI analyst (Claude):** create a key at console.anthropic.com and set `ANTHROPIC_API_KEY`. Without a key,
  the built-in offline assistant still answers common questions (cases/deaths by area and year, rankings,
  monthly trends, forecasts, weather, alerts).
- **Email alerts:** follow the steps on the Alerts tab (Gmail App Password → `GMAIL_USER`,
  `GMAIL_APP_PASSWORD`, `ALERT_EMAIL_TO`).
- **API and ABER:** need population denominators — insert BBS figures into
  `upazila_population (upazila_id, year, population)`.

## Deploy

1. Create a Postgres database (Neon or Supabase) and copy the pooled connection string.
2. Import this repository at https://vercel.com/new and add the variables from `.env.example`.
3. In GitHub → Settings → Secrets and variables → Actions, add `DATABASE_URL` (same value) so the daily
   weather/forecast pipeline can run.
4. Trigger the first import once, then run the workflow manually from the Actions tab:

```bash
SYNC_BASE_URL=https://YOUR-APP.vercel.app CRON_SECRET=YOUR_SECRET npm run sync
```

## Warehouse tables

| Table | Grain / purpose |
| --- | --- |
| `mis_monthly` | Fact table — upazila × month surveillance counts |
| `upazila_population` | Denominators for API / ABER (to be loaded) |
| `weather_district_monthly` | ERA5 monthly climate per district |
| `forecast_runs`, `forecast_monthly`, `forecast_backtest` | Model runs with accuracy, forecasts, back-test predictions |
| `alerts` | Death and surge alerts with email status |
| `mis_sync_log` | Every sync with counts and errors |

## Data sources & licences

- Malaria surveillance: National Malaria Elimination Programme (NMEP/NMCP), Bangladesh LMIS.
- Climate: ERA5 reanalysis (ECMWF / Copernicus Climate Change Service) via the Open-Meteo archive API.
- Boundaries: [geoBoundaries](https://www.geoboundaries.org) gbOpen BGD — ADM1 CC0 1.0; ADM2/ADM3 CC BY 3.0 IGO.
- Basemap: © OpenStreetMap contributors.
