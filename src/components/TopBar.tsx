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

const DATE_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "2-digit", month: "short", year: "numeric" });
const TIME_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Live clock (Bangladesh time) + current weather strip shown on every tab. */
export default function TopBar() {
  // Ticks every second; the server-rendered instant will always differ from the client's, so the
  // date/time spans below carry suppressHydrationWarning rather than deferring the first render.
  const [now, setNow] = useState(() => new Date());
  const [weather, setWeather] = useState<Weather | null>(null);

  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(clock);
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
      {item("🕒", "", `${TIME_FMT.format(now)} BST`, true)}
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
