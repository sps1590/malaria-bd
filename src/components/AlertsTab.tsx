"use client";

import { useEffect, useState } from "react";
import { MONTHS } from "@/lib/malaria-metrics";

interface Alert {
  id: number;
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
  status: string;
  email_error: string | null;
  created_at: string;
}

interface AlertsResponse {
  alerts: Alert[];
  emailConfigured: boolean;
  recipient: string;
  preview: { subject: string; html: string; text: string } | null;
}

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  emailed: { text: "Emailed", className: "bg-emerald-50 text-emerald-700" },
  seeded: { text: "Baseline (not emailed)", className: "bg-slate-100 text-slate-600" },
  email_not_configured: { text: "Email not set up", className: "bg-amber-50 text-amber-700" },
  email_failed: { text: "Email failed", className: "bg-red-50 text-red-700" },
  new: { text: "New", className: "bg-sky-50 text-sky-700" },
};

export default function AlertsTab() {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/alerts")
      .then(async (r) => (r.ok ? (r.json() as Promise<AlertsResponse>) : Promise.reject(new Error(await r.text()))))
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load alerts"));
  }, []);

  if (error) return <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>;
  if (!data) return <p className="text-sm text-slate-500">Loading alerts…</p>;

  const deaths = data.alerts.filter((a) => a.kind === "death");
  const surges = data.alerts.filter((a) => a.kind === "surge");

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Death alerts" value={deaths.length} detail={`${deaths.reduce((s, a) => s + a.observed, 0)} deaths`} tone="red" />
          <Stat label="Surge alerts" value={surges.length} detail="cases > usual + 50" tone="amber" />
          <Stat label="Email delivery" value={data.emailConfigured ? "Active" : "Not set up"} detail={data.recipient} tone={data.emailConfigured ? "green" : "slate"} />
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800">Alert log</h2>
            <p className="text-xs text-slate-500">
              Checked after every daily sync: every reported death in the latest 3 reporting months, and any district or upazila whose monthly cases exceed the median of the same month in the previous 3 years by more than 50.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Where</th>
                  <th className="px-3 py-2 font-medium">Month</th>
                  <th className="px-3 py-2 text-right font-medium">Observed</th>
                  <th className="px-3 py-2 text-right font-medium">Usual</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.alerts.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">No alerts yet.</td></tr>
                )}
                {data.alerts.map((a) => {
                  const status = STATUS_LABEL[a.status] ?? { text: a.status, className: "bg-slate-100 text-slate-600" };
                  return (
                    <tr key={a.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${a.kind === "death" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"}`}>
                          {a.kind === "death" ? "Death" : "Surge"}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-800">{a.upazila_name ?? a.district_name}</div>
                        <div className="text-xs text-slate-500">{a.upazila_name ? `${a.district_name} · ` : ""}{a.division_name} · {a.level}</div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{MONTHS[a.report_month - 1]} {a.report_year}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{a.observed.toLocaleString("en-US")}{a.kind === "death" ? " deaths" : " cases"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{a.expected === null ? "—" : Math.round(a.expected).toLocaleString("en-US")}</td>
                      <td className="px-3 py-2"><span className={`rounded px-2 py-0.5 text-xs ${status.className}`} title={a.email_error ?? undefined}>{status.text}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {!data.emailConfigured && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <h3 className="font-semibold">Turn on email alerts (one-time, ~3 minutes)</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-relaxed">
              <li>Sign in to the Gmail account that should <b>send</b> the alerts and turn on 2-Step Verification.</li>
              <li>Open <b>myaccount.google.com/apppasswords</b>, create an app password named “Malaria MIS”, and copy the 16-letter code.</li>
              <li>Add to <code>.env.local</code> (and to Vercel → Settings → Environment Variables): <code>GMAIL_USER=you@gmail.com</code>, <code>GMAIL_APP_PASSWORD=the16letters</code>, <code>ALERT_EMAIL_TO={data.recipient}</code>.</li>
              <li>Restart the app. New deaths and surges found by the next sync are emailed as one message.</li>
            </ol>
          </div>
        )}
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <h3 className="text-sm font-semibold text-slate-800">Email preview</h3>
            <p className="truncate text-xs text-slate-500">{data.preview ? data.preview.subject : "No recent alerts to preview."}</p>
          </div>
          {data.preview && <iframe title="Alert email preview" sandbox="" srcDoc={data.preview.html} className="h-[520px] w-full bg-white" />}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, detail, tone }: { label: string; value: string | number; detail: string; tone: "red" | "amber" | "green" | "slate" }) {
  const tones = {
    red: "border-red-100 bg-red-50 text-red-900",
    amber: "border-amber-100 bg-amber-50 text-amber-900",
    green: "border-emerald-100 bg-emerald-50 text-emerald-900",
    slate: "border-slate-200 bg-white text-slate-900",
  };
  return (
    <div className={`rounded-xl border p-4 ${tones[tone]}`}>
      <div className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      <div className="truncate text-xs opacity-70">{detail}</div>
    </div>
  );
}
