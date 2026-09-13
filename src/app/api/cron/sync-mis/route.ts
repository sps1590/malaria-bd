import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import postgres from "postgres";
import { z } from "zod";
import { ALERTS_SCHEMA, runAlerts } from "@/lib/alerts";
import {
  MONTHS,
  NUMERIC_FIELDS,
  divisionOfDistrict,
  type NumericSource,
} from "@/lib/malaria-metrics";

// Daily at 03:00 UTC (09:00 BST) via vercel.json. Payload is ~8 MB / ~20k rows.
export const maxDuration = 300;

const SOURCE_URL = process.env.MIS_API_URL ?? "https://lmis.nmcp.gov.bd/admin/mis-api-data";
const FETCH_ATTEMPTS = 3;
const UPSERT_BATCH = 1000; // 1000 rows x 29 cols stays well under Postgres' 65,535 bind-param limit
const MIN_VALID_RATIO = 0.9; // abort instead of half-syncing a malformed upstream payload

/* ----------------------------- Validation ----------------------------- */

const count = z.coerce.number().int().min(0);
const countShape = Object.fromEntries(NUMERIC_FIELDS.map((f) => [f.source, count])) as {
  [K in NumericSource]: typeof count;
};

const MisApiRow = z
  .object({
    DistrictID: z.coerce.number().int().positive(),
    UpazillaID: z.coerce.number().int().positive(),
    // Upstream contains junk years such as "10" and "59".
    ReportYear: z.coerce.number().int().min(2000).max(new Date().getUTCFullYear() + 1),
    ReportMonth: z
      .string()
      .trim()
      .transform((m) => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase())
      .pipe(z.enum(MONTHS)),
    DistrictName: z.string().trim().min(1),
    UpazilaName: z.string().trim().min(1),
    ...countShape,
  })
  .refine((r) => r.CASEE === r.PV + r.PF + r.MIXED, {
    message: "CASEE must equal PV + PF + MIXED",
    path: ["CASEE"],
  });

type MisApiRow = z.infer<typeof MisApiRow>;
type DbRow = Record<string, string | number>;

/* ------------------------------- Schema ------------------------------- */

const PRIMARY_KEY = ["upazila_id", "report_year", "report_month"];
const COLUMNS = [
  ...PRIMARY_KEY,
  "district_id",
  "division_name",
  "district_name",
  "upazila_name",
  ...NUMERIC_FIELDS.map((f) => f.column),
];
const MUTABLE_COLUMNS = COLUMNS.filter((c) => !PRIMARY_KEY.includes(c));

// Built only from constants above — never from request/upstream data.
const UPSERT_TAIL = `
  ON CONFLICT (${PRIMARY_KEY.join(", ")}) DO UPDATE SET
    ${MUTABLE_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(",\n    ")},
    synced_at = now()
  WHERE (${MUTABLE_COLUMNS.map((c) => `mis_monthly.${c}`).join(", ")})
    IS DISTINCT FROM (${MUTABLE_COLUMNS.map((c) => `EXCLUDED.${c}`).join(", ")})`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mis_monthly (
    upazila_id    integer     NOT NULL,
    report_year   smallint    NOT NULL,
    report_month  smallint    NOT NULL CHECK (report_month BETWEEN 1 AND 12),
    district_id   integer     NOT NULL,
    division_name text        NOT NULL,
    district_name text        NOT NULL,
    upazila_name  text        NOT NULL,
    ${NUMERIC_FIELDS.map((f) => `${f.column} integer NOT NULL DEFAULT 0 CHECK (${f.column} >= 0)`).join(",\n    ")},
    synced_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (upazila_id, report_year, report_month)
  )`,
  `ALTER TABLE mis_monthly ${NUMERIC_FIELDS.map((f) => `ADD COLUMN IF NOT EXISTS ${f.column} integer NOT NULL DEFAULT 0`).join(", ")}`,
  `CREATE INDEX IF NOT EXISTS mis_monthly_period_idx ON mis_monthly (report_year, report_month)`,
  `CREATE INDEX IF NOT EXISTS mis_monthly_district_idx ON mis_monthly (district_id, report_year)`,
  // Denominator for API / ABER. Not provided by the MIS API — load BBS projections yourself.
  `CREATE TABLE IF NOT EXISTS upazila_population (
    upazila_id integer  NOT NULL,
    year       smallint NOT NULL,
    population integer  NOT NULL CHECK (population > 0),
    source     text,
    PRIMARY KEY (upazila_id, year)
  )`,
  `CREATE TABLE IF NOT EXISTS mis_sync_log (
    id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status      text NOT NULL DEFAULT 'running',
    source_url  text NOT NULL,
    fetched     integer,
    valid       integer,
    rejected    integer,
    duplicates  integer,
    changed     integer,
    error       text
  )`,
];

/* ------------------------------- Helpers ------------------------------ */

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function fetchPayload(): Promise<unknown[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(SOURCE_URL, {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`Upstream responded HTTP ${res.status}`);
      const parsed = z.array(z.unknown()).min(1).safeParse(await res.json());
      if (!parsed.success) throw new Error("Upstream payload is not a non-empty JSON array");
      return parsed.data;
    } catch (err) {
      lastError = err;
      if (attempt < FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function toDbRow(r: MisApiRow): DbRow {
  const row: DbRow = {
    upazila_id: r.UpazillaID,
    report_year: r.ReportYear,
    report_month: MONTHS.indexOf(r.ReportMonth) + 1,
    district_id: r.DistrictID,
    division_name: divisionOfDistrict(r.DistrictName),
    district_name: r.DistrictName,
    upazila_name: r.UpazilaName,
  };
  for (const f of NUMERIC_FIELDS) row[f.column] = r[f.source];
  return row;
}

function validate(payload: unknown[]) {
  const byKey = new Map<string, DbRow>();
  const samples: { index: number; ref: string; issues: string[] }[] = [];
  let rejected = 0;
  let duplicates = 0;

  payload.forEach((raw, index) => {
    const parsed = MisApiRow.safeParse(raw);
    if (!parsed.success) {
      rejected++;
      if (samples.length < 25) {
        const o = (raw ?? {}) as Record<string, unknown>;
        samples.push({
          index,
          ref: `${o.UpazillaID}/${o.ReportYear}/${o.ReportMonth}`,
          issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(row)"}: ${i.message}`),
        });
      }
      return;
    }
    const row = toDbRow(parsed.data);
    const key = `${row.upazila_id}-${row.report_year}-${row.report_month}`;
    if (byKey.has(key)) duplicates++; // ON CONFLICT cannot touch the same key twice in one statement
    byKey.set(key, row);
  });

  return { rows: [...byKey.values()], rejected, duplicates, samples };
}

/* ------------------------------- Handler ------------------------------ */

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL is not configured" }, { status: 500 });
  }

  const startedAt = Date.now();
  const sql = postgres(databaseUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 15, onnotice: () => {} });
  let logId: number | null = null;

  try {
    for (const statement of [...SCHEMA, ...ALERTS_SCHEMA]) await sql.unsafe(statement);

    const [log] = await sql<{ id: number }[]>`
      INSERT INTO mis_sync_log (source_url) VALUES (${SOURCE_URL}) RETURNING id`;
    logId = log.id;

    const payload = await fetchPayload();
    const { rows, rejected, duplicates, samples } = validate(payload);

    if (rows.length === 0 || rows.length / payload.length < MIN_VALID_RATIO) {
      throw new Error(
        `Validation gate failed: ${rows.length}/${payload.length} valid rows (min ratio ${MIN_VALID_RATIO}). ` +
          `First issues: ${JSON.stringify(samples.slice(0, 3))}`,
      );
    }

    let changed = 0;
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const batch = rows.slice(i, i + UPSERT_BATCH);
      const result = await sql`
        INSERT INTO mis_monthly ${sql(batch, COLUMNS)}
        ${sql.unsafe(UPSERT_TAIL)}`;
      changed += result.count;
    }

    await sql`
      UPDATE mis_sync_log
      SET finished_at = now(), status = 'success', fetched = ${payload.length},
          valid = ${rows.length}, rejected = ${rejected}, duplicates = ${duplicates}, changed = ${changed}
      WHERE id = ${logId}`;

    // Deaths and sudden case surges → alerts table + one email digest (never fails the sync).
    const alerts = await runAlerts(sql);

    return NextResponse.json({
      ok: true,
      alerts,
      fetched: payload.length,
      valid: rows.length,
      rejected,
      duplicates,
      changed,
      durationMs: Date.now() - startedAt,
      rejectedSamples: samples,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sync-mis]", message);
    if (logId !== null) {
      await sql`
        UPDATE mis_sync_log SET finished_at = now(), status = 'failed', error = ${message}
        WHERE id = ${logId}`.catch(() => undefined);
    }
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
