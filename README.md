# Malaria MIS Analytics — Bangladesh

Next.js 16 (App Router, React 19, TypeScript, Tailwind v4) analytics platform for the
NMCP malaria MIS feed (`https://lmis.nmcp.gov.bd/admin/mis-api-data`).

- **Daily sync** — Vercel Cron (`vercel.json`) calls `/api/cron/sync-mis` at 03:00 UTC (09:00 BST).
  The route fetches the feed, validates every row with Zod, and upserts into Postgres.
- **Pivot tab** — drag-and-drop cross-tabulation (rows × columns × values), virtualized grid,
  medical indicators (API, TPR, ABER, CFR, Pf share), `.xlsx` and `.pdf` export.
- **BI tab** — draggable/resizable dashboard (`react-grid-layout`), KPI cards, Recharts time series,
  and a Leaflet choropleth with Division → District → Upazila drill-down.

## Run locally (Windows, no Docker needed)

Open two terminals in this folder.

Terminal 1 — start the bundled local Postgres (keep it open):

```bash
npm run db:local
```

Terminal 2 — start the app:

```bash
npm run dev
```

First time only, load the MIS data (with the dev server running):

```bash
npm run sync
```

Then open http://localhost:3000.

## Deploy to Vercel

1. Create a Postgres database (Neon or Supabase) and copy its pooled connection string.
2. Import this GitHub repository at https://vercel.com/new.
3. Add environment variables in Vercel → Project → Settings → Environment Variables:
   - `DATABASE_URL` — the connection string (include `?sslmode=require`)
   - `CRON_SECRET` — any long random string (Vercel Cron sends it automatically)
4. Deploy, then run the first import once:

```bash
SYNC_BASE_URL=https://YOUR-APP.vercel.app CRON_SECRET=YOUR_SECRET npm run sync
```

After that the cron job keeps the data fresh every day.

## Indicators

| Indicator | Formula |
| --- | --- |
| API (per 1,000) | confirmed cases ÷ population-years × 1,000 |
| TPR (%) | confirmed cases ÷ persons tested × 100 |
| ABER (%) | persons tested ÷ population-years × 100 |
| CFR (%) | deaths ÷ confirmed cases × 100 |

Ratios are always computed from summed numerators/denominators, never averaged.
Each upazila-month contributes population ÷ 12 person-years, so API/ABER are valid for any slice.

**API and ABER need population.** The MIS feed has none — insert BBS figures into
`upazila_population (upazila_id, year, population)`. The nearest available year is used.

## Project layout

| Path | Purpose |
| --- | --- |
| `vercel.json` | Cron schedule |
| `src/app/api/cron/sync-mis/route.ts` | Fetch → Zod validation → batched upsert, schema bootstrap, sync log |
| `src/lib/malaria-metrics.ts` | Data model, formulas, district→division map, geo name matching |
| `src/app/page.tsx` | Server page: loads data for the selected year range, renders the tabs |
| `src/components/PivotTab.tsx` | Pivot engine + virtualized grid + exports |
| `src/components/BiTab.tsx` | Dashboard canvas, charts, choropleth map |
| `scripts/prepare-geo.mjs` | Builds `public/geo/*.geojson` from geoBoundaries |
| `scripts/local-db.mjs` | Local embedded Postgres for development |
| `scripts/sync.mjs` | Manually trigger a sync |

## Data sources & licences

- Malaria data: National Malaria Elimination Programme (NMEP/NMCP), Bangladesh LMIS.
- Administrative boundaries: [geoBoundaries](https://www.geoboundaries.org) gbOpen BGD —
  ADM1 CC0 1.0; ADM2/ADM3 CC BY 3.0 IGO.
- Basemap tiles: © OpenStreetMap contributors.
