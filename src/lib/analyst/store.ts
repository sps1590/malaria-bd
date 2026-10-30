/**
 * Database access for the analyst. Everything goes through runReadOnly(): a Postgres transaction opened
 * as READ ONLY with a statement timeout, executed with bound parameters (never string-built values).
 */
import { getSql } from "@/lib/db";

export interface Bounds {
  firstYear: number;
  lastYear: number;
  /** Newest month with data, as a month index (year × 12 + month − 1). */
  latestP: number;
  rows: number;
}

let boundsCache: { at: number; value: Bounds } | null = null;

export async function getBounds(): Promise<Bounds> {
  if (boundsCache && Date.now() - boundsCache.at < 60_000) return boundsCache.value;
  const [b] = await runReadOnly<{ first_year: number; last_year: number; latest: number; rows: number }>(
    `SELECT min(report_year)::int AS first_year, max(report_year)::int AS last_year,
            max(report_year * 12 + report_month - 1)::int AS latest, count(*)::int AS rows
     FROM mis_monthly`,
    [],
  ).then((r) => r.rows);
  const value = { firstYear: b.first_year, lastYear: b.last_year, latestP: b.latest, rows: b.rows };
  boundsCache = { at: Date.now(), value };
  return value;
}

export interface QueryResult<T> {
  rows: T[];
  ms: number;
}

const STATEMENT_TIMEOUT_MS = 10_000;

/** Run one SELECT inside a READ ONLY transaction. */
export async function runReadOnly<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
  const sql = getSql();
  const started = Date.now();
  const rows = (await sql.begin("read only", async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    return tx.unsafe(text, params as never[]);
  })) as unknown as T[];
  return { rows: [...rows], ms: Date.now() - started };
}

/** Parameter-inlined SQL for the "How I got this" panel (display only — never executed). */
export function inlineSql(text: string, params: unknown[]): string {
  const literal = (v: unknown) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  return text
    .replace(/\$(\d+)(?:::\w+)?/g, (_, n: string) => literal(params[Number(n) - 1]))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
