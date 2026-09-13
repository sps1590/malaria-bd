// Uploads the locally prepared population, weather and forecast tables to a deployment.
// Usage: npm run seed:production            (target https://malaria-bd.vercel.app)
//        SEED_BASE_URL=https://other.app npm run seed:production
import postgres from "postgres";

const BASE = process.env.SEED_BASE_URL ?? "https://malaria-bd.vercel.app";
const TABLES = [
  "population_quantification",
  "upazila_population",
  "weather_district_monthly",
  "forecast_runs",
  "forecast_monthly",
  "forecast_backtest",
  "forecast_archive",
];
const CHUNK = 1000;

const local = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const headers = { "content-type": "application/json" };
if (process.env.SEED_WITH_CRON_SECRET && process.env.CRON_SECRET) headers.authorization = `Bearer ${process.env.CRON_SECRET}`;

async function post(body) {
  const res = await fetch(`${BASE}/api/admin/seed`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${body.action}${body.table ? ` ${body.table}` : ""}: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const plain = (v) => (v instanceof Date ? v.toISOString() : v !== null && typeof v === "object" ? JSON.stringify(v) : v);

try {
  const { token } = await post({ action: "begin" });
  for (const table of TABLES) {
    const columns = (
      await local`SELECT column_name FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = ${table} AND is_identity = 'NO'
                  ORDER BY ordinal_position`
    ).map((r) => r.column_name);
    if (!columns.length) {
      console.log(`${table}: not in local database, skipped`);
      continue;
    }
    const rows = await local.unsafe(`SELECT ${columns.join(", ")} FROM ${table}`).values();
    for (let i = 0; i < rows.length; i += CHUNK) {
      await post({ action: "rows", token, table, columns, rows: rows.slice(i, i + CHUNK).map((r) => r.map(plain)) });
    }
    console.log(`${table}: ${rows.length} rows uploaded`);
  }
  await post({ action: "finish", token });
  console.log(`Done: ${BASE}`);
} finally {
  await local.end();
}
