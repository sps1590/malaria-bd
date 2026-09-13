import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hasCronSecret } from "@/lib/cron-auth";
import { getSql, tableExists, type Sql } from "@/lib/db";

/**
 * Loads the tables prepared by the Python pipeline (population & NSP targets, ERA5 weather, forecasts) into
 * this deployment's database in chunks. Allowed only while those tables are empty (first set-up) or with
 * CRON_SECRET; a "begin" call returns a one-time token valid for 30 minutes. Only whitelisted tables and
 * columns are accepted. Client: `npm run seed:production`.
 */
export const maxDuration = 60;

const TABLES: Record<string, { ddl: string[]; columns: string[] }> = {
  population_quantification: {
    ddl: [
      `CREATE TABLE IF NOT EXISTS population_quantification (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, source_file text NOT NULL, sheet text NOT NULL,
        dataset text NOT NULL, area_level text NOT NULL, area_label text NOT NULL, district_name text, upazila_name text,
        mis_upazila_id integer, year smallint, indicator text NOT NULL, value double precision, unit text, note text,
        imported_at timestamptz NOT NULL DEFAULT now())`,
      "CREATE INDEX IF NOT EXISTS population_quantification_lookup_idx ON population_quantification (dataset, area_level, area_label, year)",
    ],
    columns: ["source_file", "sheet", "dataset", "area_level", "area_label", "district_name", "upazila_name", "mis_upazila_id",
      "year", "indicator", "value", "unit", "note", "imported_at"],
  },
  upazila_population: {
    ddl: [
      `CREATE TABLE IF NOT EXISTS upazila_population (
        upazila_id integer NOT NULL, year smallint NOT NULL, population integer NOT NULL, source text, PRIMARY KEY (upazila_id, year))`,
      "ALTER TABLE upazila_population DROP CONSTRAINT IF EXISTS upazila_population_population_check",
      "ALTER TABLE upazila_population ADD CONSTRAINT upazila_population_population_check CHECK (population >= 0)",
    ],
    columns: ["upazila_id", "year", "population", "source"],
  },
  weather_district_monthly: {
    ddl: [
      `CREATE TABLE IF NOT EXISTS weather_district_monthly (
        district_name text NOT NULL, division_name text NOT NULL, year smallint NOT NULL, month smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
        lat real NOT NULL, lon real NOT NULL, temp_mean real, temp_max real, temp_min real, precip_mm real, rainy_days smallint,
        heavy_rain_days smallint, rh_mean real, dewpoint_mean real, soil_moisture real, wind_mean real, et0_mm real,
        days smallint NOT NULL, source text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (district_name, year, month))`,
    ],
    columns: ["district_name", "division_name", "year", "month", "lat", "lon", "temp_mean", "temp_max", "temp_min", "precip_mm",
      "rainy_days", "heavy_rain_days", "rh_mean", "dewpoint_mean", "soil_moisture", "wind_mean", "et0_mm", "days", "source", "updated_at"],
  },
  forecast_runs: {
    ddl: [
      `CREATE TABLE IF NOT EXISTS forecast_runs (
        run_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), level text NOT NULL, area_key text NOT NULL,
        area_name text NOT NULL, target text NOT NULL, model text NOT NULL, horizon_months smallint NOT NULL, accuracy_pct real,
        accuracy_3m_pct real, wape real, mae real, mase real, backtest_origins smallint NOT NULL, train_start text NOT NULL,
        train_end text NOT NULL, candidates jsonb NOT NULL, notes text NOT NULL, PRIMARY KEY (run_id, level, area_key, target))`,
    ],
    columns: ["run_id", "created_at", "level", "area_key", "area_name", "target", "model", "horizon_months", "accuracy_pct",
      "accuracy_3m_pct", "wape", "mae", "mase", "backtest_origins", "train_start", "train_end", "candidates", "notes"],
  },
  forecast_monthly: {
    ddl: [
      `CREATE TABLE IF NOT EXISTS forecast_monthly (
        level text NOT NULL, area_key text NOT NULL, area_name text NOT NULL, target text NOT NULL, year smallint NOT NULL,
        month smallint NOT NULL, yhat real NOT NULL, lo80 real NOT NULL, hi80 real NOT NULL, lo95 real NOT NULL, hi95 real NOT NULL,
        model text NOT NULL, run_id text NOT NULL, PRIMARY KEY (level, area_key, target, year, month))`,
    ],
    columns: ["level", "area_key", "area_name", "target", "year", "month", "yhat", "lo80", "hi80", "lo95", "hi95", "model", "run_id"],
  },
  forecast_backtest: {
    ddl: [
      `CREATE TABLE IF NOT EXISTS forecast_backtest (
        level text NOT NULL, area_key text NOT NULL, target text NOT NULL, year smallint NOT NULL, month smallint NOT NULL,
        horizon smallint NOT NULL, actual real NOT NULL, predicted real NOT NULL, model text NOT NULL, run_id text NOT NULL,
        PRIMARY KEY (level, area_key, target, horizon, year, month))`,
    ],
    columns: ["level", "area_key", "target", "year", "month", "horizon", "actual", "predicted", "model", "run_id"],
  },
  forecast_archive: {
    ddl: [
      `CREATE TABLE IF NOT EXISTS forecast_archive (
        level text NOT NULL, area_key text NOT NULL, target text NOT NULL, train_end text NOT NULL, year smallint NOT NULL,
        month smallint NOT NULL, horizon smallint NOT NULL, yhat real NOT NULL, lo80 real NOT NULL, hi80 real NOT NULL,
        model text NOT NULL, run_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (level, area_key, target, train_end, year, month))`,
    ],
    columns: ["level", "area_key", "target", "train_end", "year", "month", "horizon", "yhat", "lo80", "hi80", "model", "run_id", "created_at"],
  },
};

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin") }),
  z.object({
    action: z.literal("rows"),
    token: z.string().min(30).max(60),
    table: z.string(),
    columns: z.array(z.string()).min(1).max(40),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1).max(2000),
  }),
  z.object({ action: z.literal("finish"), token: z.string().min(30).max(60) }),
]);

async function seedTablesEmpty(sql: Sql): Promise<boolean> {
  for (const table of Object.keys(TABLES)) {
    if ((await tableExists(sql, table)) && (await sql`SELECT 1 FROM ${sql(table)} LIMIT 1`).length > 0) return false;
  }
  return true;
}

async function tokenValid(sql: Sql, token: string): Promise<boolean> {
  if (!(await tableExists(sql, "seed_session"))) return false;
  return (await sql`SELECT 1 FROM seed_session WHERE token = ${token} AND expires_at > now()`).length > 0;
}

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
  const body = parsed.data;
  const sql = getSql();

  if (body.action === "begin") {
    const authorized = hasCronSecret(request);
    if (!authorized && !(await seedTablesEmpty(sql))) {
      return Response.json({ ok: false, error: "Tables already contain data; CRON_SECRET required." }, { status: 409 });
    }
    await sql.unsafe("CREATE TABLE IF NOT EXISTS seed_session (token text PRIMARY KEY, expires_at timestamptz NOT NULL)");
    for (const spec of Object.values(TABLES)) for (const statement of spec.ddl) await sql.unsafe(statement);
    for (const table of Object.keys(TABLES)) await sql`TRUNCATE ${sql(table)}`;
    const token = randomUUID();
    await sql`INSERT INTO seed_session (token, expires_at) VALUES (${token}, now() + interval '30 minutes')`;
    return Response.json({ ok: true, token, tables: Object.keys(TABLES) });
  }

  if (!(await tokenValid(sql, body.token))) return Response.json({ ok: false, error: "Invalid or expired token" }, { status: 401 });

  if (body.action === "finish") {
    await sql`DELETE FROM seed_session WHERE token = ${body.token} OR expires_at <= now()`;
    return Response.json({ ok: true });
  }

  const spec = TABLES[body.table];
  if (!spec || body.columns.some((c) => !spec.columns.includes(c)) || body.rows.some((r) => r.length !== body.columns.length)) {
    return Response.json({ ok: false, error: "Unknown table or columns" }, { status: 400 });
  }
  const objects = body.rows.map((row) => Object.fromEntries(body.columns.map((column, i) => [column, row[i]]))) as Record<
    string,
    string | number | boolean | null
  >[];
  const columns: string[] = body.columns;
  await sql`INSERT INTO ${sql(body.table)} ${sql(objects, columns)}`;
  return Response.json({ ok: true, inserted: objects.length });
}
