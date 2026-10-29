"use client";

import { useCallback, useEffect, useState } from "react";
import { MONTHS } from "@/lib/malaria-metrics";

interface SyncStatus {
  lastSync: string | null;
  latestDataMonth: string | null; // "2026-09"
  running?: boolean;
}

type Phase = "idle" | "syncing" | "updated" | "current" | "error";

const STALE_MS = 6 * 60 * 60_000; // data older than this is refreshed automatically
const RECHECK_MS = 30 * 60_000; // an open tab re-checks this often
const AUTO_RETRY_KEY = "malaria-mis:last-auto-sync";
const AUTO_RETRY_MS = 10 * 60_000; // never auto-retry faster than this, even across page loads

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function monthLabel(ym: string | null): string {
  if (!ym) return "—";
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]?.slice(0, 3) ?? "?"} ${y}`;
}

/**
 * "Sync now" button for the page header. Calls POST /api/sync (the same upstream pull the daily cron
 * does) and reloads the page when new data arrived. It also keeps the data fresh on its own: on load and
 * every 30 minutes, if the last successful sync is older than 6 hours it syncs in the background.
 */
export default function SyncControl() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const runSync = useCallback(async (manual: boolean) => {
    setPhase("syncing");
    setDetail("");
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean; throttled?: string | false; changed?: number; lastSync?: string | null; latestDataMonth?: string | null; error?: string;
      };
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
      setStatus((s) => ({ lastSync: body.lastSync ?? s?.lastSync ?? null, latestDataMonth: body.latestDataMonth ?? s?.latestDataMonth ?? null }));
      const changed = body.changed ?? 0;
      if (changed > 0) {
        setPhase("updated");
        setDetail(`${changed.toLocaleString("en-US")} records updated — reloading…`);
        window.setTimeout(() => window.location.reload(), 1200); // client-fetched tabs only refetch on a fresh load
      } else {
        setPhase("current");
        setDetail(body.throttled === "running" ? "Sync already running" : body.throttled === "recent" ? "Just synced" : "Already up to date");
        window.setTimeout(() => setPhase("idle"), 4000);
      }
    } catch (err) {
      setPhase("error");
      setDetail(manual ? `Sync failed — ${err instanceof Error ? err.message : "try again"}` : "");
      window.setTimeout(() => setPhase("idle"), 6000);
    }
  }, []);

  // Status on load; sync automatically if stale. Re-check periodically while the tab stays open.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/sync", { cache: "no-store" });
        const s = (await res.json()) as SyncStatus & { ok?: boolean };
        if (cancelled || s.ok === false) return;
        setStatus({ lastSync: s.lastSync, latestDataMonth: s.latestDataMonth });
        const stale = !s.lastSync || Date.now() - new Date(s.lastSync).getTime() > STALE_MS;
        let recentlyTried = false;
        try {
          recentlyTried = Date.now() - Number(window.sessionStorage.getItem(AUTO_RETRY_KEY) ?? 0) < AUTO_RETRY_MS;
        } catch {
          /* storage blocked — rely on the server-side cooldown */
        }
        if (stale && !s.running && !recentlyTried) {
          try {
            window.sessionStorage.setItem(AUTO_RETRY_KEY, String(Date.now()));
          } catch {
            /* ignore */
          }
          void runSync(false);
        }
      } catch {
        /* offline — nothing to show */
      }
    };
    void check();
    const poll = setInterval(() => void check(), RECHECK_MS);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [runSync]);

  const stale = !!status && (!status.lastSync || now - new Date(status.lastSync).getTime() > STALE_MS * 4);
  const busy = phase === "syncing";
  const message =
    phase === "syncing" ? "Pulling the latest MIS data…"
    : detail ? detail
    : status ? `Data to ${monthLabel(status.latestDataMonth)} · synced ${ago(status.lastSync, now)}`
    : "Checking data…";

  return (
    <span className="ml-auto flex items-center gap-2 whitespace-nowrap">
      <span
        role="status"
        aria-live="polite"
        className={`${phase === "error" ? "text-red-300" : phase === "updated" ? "text-emerald-300" : stale ? "text-amber-300" : "text-indigo-300/80"}`}
        suppressHydrationWarning
      >
        {message}
      </span>
      <button
        type="button"
        onClick={() => void runSync(true)}
        disabled={busy}
        title="Pull the latest data from the NMEP MIS server and update this system"
        className="flex items-center gap-1.5 rounded-full border border-cyan-400/40 bg-cyan-400/10 px-3 py-1 font-medium text-cyan-100 transition hover:bg-cyan-400/20 disabled:cursor-wait disabled:opacity-70"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden>
          <path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />
        </svg>
        {busy ? "Syncing…" : "Sync now"}
      </button>
    </span>
  );
}
