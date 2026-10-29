import { NextResponse } from "next/server";
import { databaseUrl, getSql, tableExists, type Sql } from "@/lib/db";
import { runMisSync } from "@/lib/mis-sync";

/**
 * Public "Sync now" endpoint behind the button in the page header.
 *
 * It takes no input: it only re-reads the fixed NMEP MIS feed and upserts it (idempotent), so it is safe
 * to expose without a secret — but it is throttled so it can't be used to hammer the upstream server or
 * the database: at most one sync per COOLDOWN_MS, and never two at once. The daily cron route
 * (/api/cron/sync-mis, protected by CRON_SECRET) shares the same sync code.
 */
export const maxDuration = 300;

const COOLDOWN_MS = 2 * 60_000;
const DEAD_RUN_MS = 6 * 60_000; // a "running" row older than this is a crashed run, not a live one

async function syncState(sql: Sql) {
  if (!(await tableExists(sql, "mis_sync_log"))) {
    return { lastSuccess: null as Date | null, lastAttempt: null as Date | null, running: false, latest: null as string | null };
  }
  const [last] = await sql<{ finished_at: Date }[]>`
    SELECT finished_at FROM mis_sync_log WHERE status = 'success' ORDER BY id DESC LIMIT 1`;
  // Failed attempts count towards the cooldown too, so a broken upstream isn't retried on every page load.
  const [attempt] = await sql<{ started_at: Date }[]>`SELECT started_at FROM mis_sync_log ORDER BY id DESC LIMIT 1`;
  const running = (await sql`
    SELECT 1 FROM mis_sync_log WHERE status = 'running' AND started_at > now() - make_interval(secs => ${DEAD_RUN_MS / 1000}) LIMIT 1`).length > 0;
  let latest: string | null = null;
  if (await tableExists(sql, "mis_monthly")) {
    const [row] = await sql<{ p: number | null }[]>`SELECT max(report_year * 100 + report_month)::int AS p FROM mis_monthly`;
    if (row?.p) latest = `${Math.floor(row.p / 100)}-${String(row.p % 100).padStart(2, "0")}`;
  }
  return { lastSuccess: last?.finished_at ?? null, lastAttempt: attempt?.started_at ?? null, running, latest };
}

const noStore = { "cache-control": "no-store" };

export async function GET() {
  try {
    const s = await syncState(getSql());
    return NextResponse.json({ ok: true, lastSync: s.lastSuccess?.toISOString() ?? null, running: s.running, latestDataMonth: s.latest }, { headers: noStore });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Status unavailable" }, { status: 500, headers: noStore });
  }
}

export async function POST() {
  const url = databaseUrl();
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL is not configured" }, { status: 500, headers: noStore });

  try {
    const s = await syncState(getSql());
    if (s.running) {
      return NextResponse.json({ ok: true, throttled: "running", changed: 0, lastSync: s.lastSuccess?.toISOString() ?? null, latestDataMonth: s.latest }, { headers: noStore });
    }
    if (s.lastAttempt && Date.now() - s.lastAttempt.getTime() < COOLDOWN_MS) {
      return NextResponse.json({ ok: true, throttled: "recent", changed: 0, lastSync: s.lastSuccess?.toISOString() ?? null, latestDataMonth: s.latest }, { headers: noStore });
    }
  } catch {
    // First ever run: the log table doesn't exist yet — fall through, the sync creates the schema.
  }

  const { status, body } = await runMisSync(url);
  const after = status === 200 ? await syncState(getSql()).catch(() => null) : null;
  return NextResponse.json(
    { ...body, throttled: false, lastSync: after?.lastSuccess?.toISOString() ?? null, latestDataMonth: after?.latest ?? null },
    { status, headers: noStore },
  );
}
