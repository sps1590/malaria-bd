import nodemailer from "nodemailer";
import type postgres from "postgres";
import { MONTHS } from "@/lib/malaria-metrics";

type Sql = ReturnType<typeof postgres>;

/** A surge is observed cases exceeding the usual pattern for that month by more than this. */
export const SURGE_EXCESS_THRESHOLD = 50;
/** Only the most recent reporting months are checked, so historical data never floods the inbox. */
export const ALERT_LOOKBACK_MONTHS = 3;
export const DEFAULT_ALERT_EMAIL = "shahriarnmp@gmail.com";

export const ALERTS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS alerts (
    id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at    timestamptz NOT NULL DEFAULT now(),
    kind          text     NOT NULL CHECK (kind IN ('death', 'surge')),
    level         text     NOT NULL CHECK (level IN ('upazila', 'district')),
    division_name text     NOT NULL,
    district_name text     NOT NULL,
    upazila_name  text,
    report_year   smallint NOT NULL,
    report_month  smallint NOT NULL,
    observed      integer  NOT NULL,
    expected      real,
    excess        real,
    details       jsonb    NOT NULL DEFAULT '{}',
    status        text     NOT NULL DEFAULT 'new',
    email_error   text,
    dedupe_key    text     NOT NULL UNIQUE
  )`,
  `CREATE INDEX IF NOT EXISTS alerts_created_idx ON alerts (created_at DESC)`,
];

export interface AlertRecord {
  id: number;
  created_at: Date;
  kind: "death" | "surge";
  level: "upazila" | "district";
  division_name: string;
  district_name: string;
  upazila_name: string | null;
  report_year: number;
  report_month: number;
  observed: number;
  expected: number | null;
  excess: number | null;
  details: Record<string, unknown>;
  status: string;
  email_error: string | null;
  dedupe_key: string;
}

type NewAlert = Omit<AlertRecord, "id" | "created_at" | "status" | "email_error">;

/* ------------------------------ Detection ------------------------------ */

async function findDeaths(sql: Sql): Promise<NewAlert[]> {
  const rows = await sql<
    {
      upazila_id: number; division_name: string; district_name: string; upazila_name: string;
      report_year: number; report_month: number; deaths: number; cases: number; severe: number;
      pf: number; pv: number; mixed: number;
    }[]
  >`
    WITH latest AS (SELECT max(report_year * 12 + report_month - 1) AS p FROM mis_monthly)
    SELECT m.upazila_id, m.division_name, m.district_name, m.upazila_name, m.report_year, m.report_month,
           m.deaths, m.cases, m.severe, m.pf, m.pv, m.mixed
    FROM mis_monthly m, latest
    WHERE m.deaths > 0 AND m.report_year * 12 + m.report_month - 1 > latest.p - ${ALERT_LOOKBACK_MONTHS}`;
  return rows.map((r) => ({
    kind: "death",
    level: "upazila",
    division_name: r.division_name,
    district_name: r.district_name,
    upazila_name: r.upazila_name,
    report_year: r.report_year,
    report_month: r.report_month,
    observed: r.deaths,
    expected: null,
    excess: null,
    details: { cases: r.cases, severe: r.severe, pf: r.pf, pv: r.pv, mixed: r.mixed },
    // A later upward revision of the death count produces a fresh alert.
    dedupe_key: `death:${r.upazila_id}:${r.report_year}-${r.report_month}:${r.deaths}`,
  }));
}

/** Usual pattern = median of the same calendar month in the previous 3 years (missing months = 0). */
async function findSurges(sql: Sql, level: "district" | "upazila"): Promise<NewAlert[]> {
  const rows = await sql<
    {
      area_key: string; division_name: string; district_name: string; upazila_name: string | null;
      report_year: number; report_month: number; cases: number; expected: number; baseline: number[];
    }[]
  >`
    WITH latest AS (SELECT max(report_year * 12 + report_month - 1) AS p FROM mis_monthly),
    series AS (
      SELECT ${level === "district" ? sql`district_name` : sql`upazila_id::text`} AS area_key,
             min(division_name) AS division_name,
             min(district_name) AS district_name,
             ${level === "district" ? sql`NULL::text` : sql`min(upazila_name)`} AS upazila_name,
             report_year, report_month,
             report_year * 12 + report_month - 1 AS p,
             sum(cases)::int AS cases
      FROM mis_monthly
      GROUP BY 1, report_year, report_month
    ),
    recent AS (SELECT s.* FROM series s, latest WHERE s.p > latest.p - ${ALERT_LOOKBACK_MONTHS})
    SELECT r.area_key, r.division_name, r.district_name, r.upazila_name, r.report_year, r.report_month, r.cases,
           b.expected, b.baseline
    FROM recent r
    CROSS JOIN LATERAL (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY coalesce(h.cases, 0))::real AS expected,
             array_agg(coalesce(h.cases, 0) ORDER BY k) AS baseline
      FROM generate_series(1, 3) AS k
      LEFT JOIN series h ON h.area_key = r.area_key AND h.p = r.p - 12 * k
    ) b
    WHERE r.cases - b.expected > ${SURGE_EXCESS_THRESHOLD}`;
  return rows.map((r) => ({
    kind: "surge",
    level,
    division_name: r.division_name,
    district_name: r.district_name,
    upazila_name: r.upazila_name,
    report_year: r.report_year,
    report_month: r.report_month,
    observed: r.cases,
    expected: r.expected,
    excess: r.cases - r.expected,
    details: { baselineYears: [1, 2, 3].map((k) => r.report_year - k), baselineCases: r.baseline },
    dedupe_key: `surge:${level}:${r.area_key}:${r.report_year}-${r.report_month}`,
  }));
}

/* ------------------------------ Email text ----------------------------- */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const monthLabel = (y: number, m: number) => `${MONTHS[m - 1]} ${y}`;
const int = (n: number) => Math.round(n).toLocaleString("en-US");
// MIS "upazila" rows also include facilities (hospitals, CS offices, medical colleges).
const FACILITY = /hospital|college|office|smo|others|nmcp|cmrl|bitid|complex|beded/i;
const place = (a: AlertRecord) =>
  a.upazila_name
    ? `${a.upazila_name} ${FACILITY.test(a.upazila_name) ? "(reporting unit)" : "upazila"}, ${a.district_name} district (${a.division_name})`
    : `${a.district_name} district (${a.division_name})`;

/** Pre-generated message template; facts that describe what happened are bold. */
export function buildAlertEmail(alerts: AlertRecord[], appUrl?: string) {
  const deaths = alerts.filter((a) => a.kind === "death");
  const surges = alerts.filter((a) => a.kind === "surge").sort((a, b) => (b.excess ?? 0) - (a.excess ?? 0));
  const deathTotal = deaths.reduce((s, a) => s + a.observed, 0);
  const latest = alerts.reduce((p, a) => Math.max(p, a.report_year * 12 + a.report_month - 1), 0);
  const period = monthLabel(Math.floor(latest / 12), (latest % 12) + 1);

  const headline = [
    deathTotal ? `${deathTotal} malaria death${deathTotal === 1 ? "" : "s"}` : "",
    surges.length ? `${surges.length} sudden case increase${surges.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" and ");
  const subject = `[Malaria MIS Alert] ${headline} — up to ${period}`;

  const deathLine = (a: AlertRecord, html: boolean) => {
    const d = a.details as { cases?: number; severe?: number; pf?: number; pv?: number; mixed?: number };
    const b = (s: string) => (html ? `<b>${esc(s)}</b>` : s.toUpperCase() === s ? s : `*${s}*`);
    const t = (s: string) => (html ? esc(s) : s);
    const context = d.cases
      ? ` — ${int(d.cases)} confirmed cases there that month (P. falciparum ${int(d.pf ?? 0)}, P. vivax ${int(d.pv ?? 0)}, mixed ${int(d.mixed ?? 0)}; severe ${int(d.severe ?? 0)}).`
      : " — no confirmed cases were recorded there for that month.";
    return `${b(`${a.observed} malaria death${a.observed === 1 ? "" : "s"}`)}${t(" reported in ")}${b(place(a))}${t(" for ")}${b(monthLabel(a.report_year, a.report_month))}${t(context)}`;
  };
  const surgeLine = (a: AlertRecord, html: boolean) => {
    const d = a.details as { baselineYears?: number[] };
    const b = (s: string) => (html ? `<b>${esc(s)}</b>` : `*${s}*`);
    const t = (s: string) => (html ? esc(s) : s);
    const years = d.baselineYears?.length ? `${Math.min(...d.baselineYears)}–${Math.max(...d.baselineYears)}` : "previous 3 years";
    return `${b(place(a))}${t(": ")}${b(`${int(a.observed)} cases`)}${t(" in ")}${b(monthLabel(a.report_year, a.report_month))}${t(
      ` versus a usual ~${int(a.expected ?? 0)} (median of ${MONTHS[a.report_month - 1]} ${years}) — `,
    )}${b(`+${int(a.excess ?? 0)} cases above normal`)}${t(".")}`;
  };

  const section = (title: string, items: AlertRecord[], line: (a: AlertRecord, html: boolean) => string) =>
    items.length
      ? {
          html: `<h3 style="margin:18px 0 6px;color:#991b1b">${esc(title)}</h3><ul style="margin:0;padding-left:18px">${items
            .map((a) => `<li style="margin:4px 0">${line(a, true)}</li>`)
            .join("")}</ul>`,
          text: `${title.toUpperCase()}\n${items.map((a) => `- ${line(a, false)}`).join("\n")}\n`,
        }
      : { html: "", text: "" };

  const deathSection = section(`Deaths (${deathTotal})`, deaths, deathLine);
  const surgeSection = section(`Sudden case increases (${surges.length})`, surges, surgeLine);
  const footerText = `How this was detected: every death reported in the last ${ALERT_LOOKBACK_MONTHS} reporting months is alerted once; a surge is a district or upazila whose monthly confirmed cases exceed the median of the same month in the previous 3 years by more than ${SURGE_EXCESS_THRESHOLD}. Source: NMEP MIS, checked automatically after the daily 09:00 BST sync.`;

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;max-width:680px">
<h2 style="margin:0 0 4px;color:#b91c1c">Malaria MIS automated alert</h2>
<p style="margin:0 0 12px">The latest National Malaria Elimination Programme data shows <b>${esc(headline)}</b> that need attention (data up to <b>${esc(period)}</b>).</p>
${deathSection.html}${surgeSection.html}
<p style="margin:18px 0 0;font-size:12px;color:#475569">${esc(footerText)}</p>
${appUrl ? `<p style="font-size:12px"><a href="${esc(appUrl)}">Open the Malaria MIS dashboard</a></p>` : ""}
</div>`;
  const text = `MALARIA MIS AUTOMATED ALERT\nThe latest NMEP data shows ${headline} that need attention (data up to ${period}).\n\n${deathSection.text}\n${surgeSection.text}\n${footerText}${appUrl ? `\n\nDashboard: ${appUrl}` : ""}\n`;
  return { subject, html, text };
}

/* ------------------------------ Delivery ------------------------------- */

export function emailConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

async function sendEmail(message: { subject: string; html: string; text: string }) {
  const transport = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transport.sendMail({
    from: `"Malaria MIS Alerts" <${process.env.GMAIL_USER}>`,
    to: process.env.ALERT_EMAIL_TO ?? DEFAULT_ALERT_EMAIL,
    ...message,
  });
}

const ALERT_COLUMNS = [
  "kind", "level", "division_name", "district_name", "upazila_name", "report_year", "report_month",
  "observed", "expected", "excess", "details", "status", "dedupe_key",
] as const;

export interface AlertRunSummary {
  detected: number;
  created: number;
  deaths: number;
  surges: number;
  email: "sent" | "not_configured" | "nothing_new" | "seeded_without_email" | "failed";
  error?: string;
}

/** Detect new death/surge alerts after a sync and email one combined digest. Never throws. */
export async function runAlerts(sql: Sql): Promise<AlertRunSummary> {
  try {
    const [{ existing }] = await sql<{ existing: number }[]>`SELECT count(*)::int AS existing FROM alerts`;
    const candidates = [
      ...(await findDeaths(sql)),
      ...(await findSurges(sql, "district")),
      ...(await findSurges(sql, "upazila")),
    ];
    // First ever run: record the current situation without emailing a backlog.
    const initialStatus = existing === 0 ? "seeded" : "new";
    const rows = candidates.map((a) => ({ ...a, details: JSON.stringify(a.details), status: initialStatus }));
    const columns: (keyof (typeof rows)[number])[] = [...ALERT_COLUMNS];
    const created: AlertRecord[] = rows.length
      ? await sql<AlertRecord[]>`
          INSERT INTO alerts ${sql(rows, columns)}
          ON CONFLICT (dedupe_key) DO NOTHING
          RETURNING *`
      : [];

    const summary: AlertRunSummary = {
      detected: candidates.length,
      created: created.length,
      deaths: created.filter((a) => a.kind === "death").reduce((s, a) => s + a.observed, 0),
      surges: created.filter((a) => a.kind === "surge").length,
      email: "nothing_new",
    };
    if (!created.length) return summary;
    if (initialStatus === "seeded") return { ...summary, email: "seeded_without_email" };

    const ids = created.map((a) => a.id);
    if (!emailConfigured()) {
      await sql`UPDATE alerts SET status = 'email_not_configured' WHERE id IN ${sql(ids)}`;
      return { ...summary, email: "not_configured" };
    }
    try {
      await sendEmail(buildAlertEmail(created, process.env.APP_URL));
      await sql`UPDATE alerts SET status = 'emailed' WHERE id IN ${sql(ids)}`;
      return { ...summary, email: "sent" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await sql`UPDATE alerts SET status = 'email_failed', email_error = ${message} WHERE id IN ${sql(ids)}`;
      return { ...summary, email: "failed", error: message };
    }
  } catch (err) {
    return { detected: 0, created: 0, deaths: 0, surges: 0, email: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
