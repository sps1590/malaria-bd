import { type AlertRecord, alertRecipient, buildAlertEmail, emailConfigured, emailDryRun } from "@/lib/alerts";
import { getSql, tableExists } from "@/lib/db";

/** Alert feed for the dashboard, plus a preview of the email digest for the latest alerts. */
export async function GET() {
  const base = { emailConfigured: emailConfigured(), dryRun: emailDryRun(), recipient: alertRecipient() };
  const sql = getSql();
  if (!(await tableExists(sql, "alerts"))) return Response.json({ alerts: [], ...base, preview: null });
  const alerts = await sql<AlertRecord[]>`
    SELECT * FROM alerts ORDER BY report_year DESC, report_month DESC, kind, excess DESC NULLS LAST, id DESC LIMIT 100`;
  const latest = alerts[0] ? alerts[0].report_year * 12 + alerts[0].report_month : 0;
  const recent = alerts.filter((a) => latest - (a.report_year * 12 + a.report_month) < 3);
  return Response.json({
    alerts,
    ...base,
    preview: recent.length ? buildAlertEmail(recent, process.env.APP_URL) : null,
  });
}
