import { NextResponse } from "next/server";

/**
 * Live current-conditions strip for the header: temperature, rainfall, precipitation
 * chance and humidity for Dhaka (national reference point), from Open-Meteo (no key
 * needed). Cached at the edge/server for 10 minutes — this is a status strip, not a
 * forecast tool (see /api/insights/climate for the ERA5 analysis used by BI/AI).
 */
export const revalidate = 600;

const DHAKA = { lat: 23.8103, lon: 90.4125 };

interface OpenMeteoCurrent {
  current: {
    time: string;
    temperature_2m: number;
    relative_humidity_2m: number;
    precipitation: number;
  };
  daily: {
    precipitation_sum: number[];
    precipitation_probability_max: number[];
  };
}

export async function GET() {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(DHAKA.lat));
  url.searchParams.set("longitude", String(DHAKA.lon));
  url.searchParams.set("current", "temperature_2m,relative_humidity_2m,precipitation");
  url.searchParams.set("daily", "precipitation_sum,precipitation_probability_max");
  url.searchParams.set("timezone", "Asia/Dhaka");
  url.searchParams.set("forecast_days", "1");

  try {
    const res = await fetch(url, { next: { revalidate }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const data = (await res.json()) as OpenMeteoCurrent;
    return NextResponse.json({
      available: true,
      source: "Open-Meteo (live)",
      location: "Dhaka",
      observed_at: data.current.time,
      temperature_c: data.current.temperature_2m,
      humidity_pct: data.current.relative_humidity_2m,
      precipitation_now_mm: data.current.precipitation,
      rainfall_today_mm: data.daily.precipitation_sum?.[0] ?? null,
      precip_chance_pct: data.daily.precipitation_probability_max?.[0] ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { available: false, error: err instanceof Error ? err.message : "Weather service unavailable" },
      { status: 502 },
    );
  }
}
