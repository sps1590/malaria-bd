"use client";

import { useEffect, useState } from "react";

interface Weather {
  available: boolean;
  location?: string;
  temperature_c?: number;
  humidity_pct?: number;
  rainfall_today_mm?: number;
  precip_chance_pct?: number;
}

// Pinned to Bangladesh time (Asia/Dhaka, UTC+6, no DST) rather than the viewer's own device
// time zone — this is an NMEP Bangladesh system, so a viewer opening it from elsewhere should
// still see the same Bangladesh date/time everyone in-country is working from, not their own.
// timeZoneName renders the "GMT+6" label beside the clock (Bangladesh has no distinct
// abbreviation like "BST" in the IANA data); hour12 gives AM/PM.
const DATE_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", weekday: "short", day: "2-digit", month: "short", year: "numeric" });
const TIME_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short" });
const DHAKA_DATE_PARTS = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" });

/** ISO-8601 week number (Monday start, week 1 contains the year's first Thursday) for Bangladesh's calendar date. */
function isoWeek(date: Date): number {
  const parts = DHAKA_DATE_PARTS.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const d = new Date(get("year"), get("month") - 1, get("day"));
  const dayNum = d.getDay() || 7; // Sunday (0) -> 7
  d.setDate(d.getDate() + 4 - dayNum); // Thursday of the same ISO week
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** Live clock (Bangladesh time) + current weather strip shown on every tab. */
export default function TopBar() {
  // Ticks every second; the server-rendered instant will always differ from the client's, so the
  // date/time spans below carry suppressHydrationWarning rather than deferring the first render.
  const [now, setNow] = useState(() => new Date());
  const [weather, setWeather] = useState<Weather | null>(null);

  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), 1000);
    // Browsers throttle (or fully pause) setInterval in a backgrounded tab, so a long-idle tab can
    // sit on a stale date/time until it happens to fire again — catch up immediately on refocus.
    const onVisible = () => {
      if (document.visibilityState === "visible") setNow(new Date());
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/weather/current")
        .then((r) => r.json())
        .then((j: Weather) => !cancelled && setWeather(j))
        .catch(() => !cancelled && setWeather({ available: false }));
    load();
    const poll = setInterval(load, 10 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, []);

  const item = (icon: string, label: string, value: string, suppressHydrationWarning?: boolean) => (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden>{icon}</span>
      <span className="text-indigo-300">{label}</span>
      <span className="font-semibold text-white" suppressHydrationWarning={suppressHydrationWarning}>{value}</span>
    </span>
  );

  return (
    <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-5 gap-y-1 border-b border-white/10 px-6 py-1.5 text-xs text-indigo-100">
      {item("📅", "", DATE_FMT.format(now), true)}
      {item("🗓️", "Week", String(isoWeek(now)), true)}
      {item("🕒", "", TIME_FMT.format(now), true)}
      <span className="hidden h-3 w-px bg-white/15 sm:inline-block" aria-hidden />
      {weather?.available ? (
        <>
          {item("🌡️", "Temp", `${weather.temperature_c}°C`)}
          {item("🌧️", "Rainfall (today)", `${weather.rainfall_today_mm ?? 0} mm`)}
          {item("☔", "Precip. chance", `${weather.precip_chance_pct ?? 0}%`)}
          {item("💧", "Humidity", `${weather.humidity_pct}%`)}
          <span className="text-indigo-300/70">· {weather.location}, live via Open-Meteo</span>
        </>
      ) : weather && !weather.available ? (
        <span className="text-indigo-300/70">Live weather unavailable right now</span>
      ) : (
        <span className="text-indigo-300/70">Loading weather…</span>
      )}
    </div>
  );
}
