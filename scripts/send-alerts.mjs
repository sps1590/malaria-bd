// Email the latest death alerts right now (including ones recorded before Gmail was set up).
//   npm run alerts:send                 # alerts not yet emailed
//   npm run alerts:send -- --resend     # everything in the window again
// Uses APP_URL (default http://localhost:3000) and CRON_SECRET from .env.local.
const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const resend = process.argv.includes("--resend");
const res = await fetch(`${base}/api/alerts/send${resend ? "?resend=1" : ""}`, {
  method: "POST",
  headers: process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {},
});
const body = await res.json().catch(() => ({}));
console.log(res.status, JSON.stringify(body));
if (body.email === "sent") console.log(`✓ Emailed ${body.emailed} alert(s) (${body.deaths} deaths) to ${body.recipient}`);
if (body.email === "not_configured") console.log("Gmail is not set up yet: add GMAIL_USER and GMAIL_APP_PASSWORD (see the Alerts tab).");
if (!body.ok) process.exit(1);
