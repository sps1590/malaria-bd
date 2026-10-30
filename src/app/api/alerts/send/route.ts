import { emailDeathsNow } from "@/lib/alerts";
import { hasCronSecret } from "@/lib/cron-auth";
import { getSql, tableExists } from "@/lib/db";

export const maxDuration = 60;

/**
 * Email the latest death alerts right now (including ones recorded before Gmail was set up).
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/alerts/send"            # not yet emailed
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/alerts/send?resend=1"   # everything again
 * Protected like the cron route, so only the operator can make the server send mail.
 */
export async function POST(request: Request) {
  if (!hasCronSecret(request)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const sql = getSql();
  if (!(await tableExists(sql, "alerts"))) return Response.json({ ok: false, error: "No alerts table yet — run a sync first." }, { status: 409 });
  const resend = new URL(request.url).searchParams.get("resend") === "1";
  const summary = await emailDeathsNow(sql, { resend });
  return Response.json({ ok: summary.email === "sent" || summary.email === "dry_run" || summary.email === "nothing_new", ...summary });
}
