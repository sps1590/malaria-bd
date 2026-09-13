// Triggers the MIS sync route manually (same endpoint Vercel Cron calls).
// Usage: npm run sync            (local dev server)
//        SYNC_BASE_URL=https://your-app.vercel.app npm run sync
const base = process.env.SYNC_BASE_URL ?? "http://localhost:3000";
const secret = process.env.CRON_SECRET;

const res = await fetch(`${base}/api/cron/sync-mis`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const body = await res.json().catch(() => ({}));
const { rejectedSamples, ...summary } = body;
console.log(res.status, JSON.stringify(summary, null, 2));
if (rejectedSamples?.length) console.log("Rejected row samples:", JSON.stringify(rejectedSamples, null, 2));
if (!res.ok) process.exit(1);
