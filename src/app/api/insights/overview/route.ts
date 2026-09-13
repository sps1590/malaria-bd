import { dataOverview, getForecast, recentAlerts } from "@/lib/agent-data";

/** Command-center snapshot: headline numbers, national forecasts and the latest alerts. */
export async function GET() {
  try {
    const [overview, cases, deaths, alerts] = await Promise.all([
      dataOverview(),
      getForecast({ target: "cases" }),
      getForecast({ target: "deaths" }),
      recentAlerts({ limit: 6 }),
    ]);
    return Response.json({ overview, forecast: { cases, deaths }, alerts: alerts.alerts });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load overview" }, { status: 500 });
  }
}
