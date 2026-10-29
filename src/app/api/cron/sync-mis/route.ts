import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { databaseUrl } from "@/lib/db";
import { isEmptyWarehouse, runMisSync } from "@/lib/mis-sync";

// Daily at 03:00 UTC (09:00 BST) via vercel.json. Payload is ~8 MB / ~20k rows.
export const maxDuration = 300;

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(request: NextRequest) {
  const url = databaseUrl();
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL is not configured" }, { status: 500 });
  // A brand-new deployment may load the public feed once without the secret; after that every call needs it.
  if (!isAuthorized(request) && !(await isEmptyWarehouse(url))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { status, body } = await runMisSync(url);
  return NextResponse.json(body, { status });
}
