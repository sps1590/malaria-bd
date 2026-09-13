import { dataOverview, getForecast, recentAlerts } from "@/lib/agent-data";
import { nspComparison } from "@/lib/nsp";

/** Command-center snapshot: headline numbers, population & NSP targets, national forecasts and the latest alerts. */
export async function GET() {
  try {
    const [overview, cases, deaths, alerts, nsp] = await Promise.all([
      dataOverview(),
      getForecast({ target: "cases" }),
      getForecast({ target: "deaths" }),
      recentAlerts({ limit: 6 }),
      nspComparison(),
    ]);
    return Response.json({ overview, forecast: { cases, deaths }, alerts: alerts.alerts, nsp });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load overview" }, { status: 500 });
  }
}
