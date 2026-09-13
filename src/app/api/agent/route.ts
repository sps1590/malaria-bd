import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import {
  climateCorrelation,
  dataOverview,
  getForecast,
  getWeather,
  malariaStats,
  recentAlerts,
} from "@/lib/agent-data";
import { nspComparison } from "@/lib/nsp";
import { answerOffline } from "@/lib/offline-assistant";

export const maxDuration = 120;

const MODEL = "claude-opus-5";
const RATE_LIMIT_PER_MINUTE = 12;

const Body = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) }))
    .min(1)
    .max(30)
    .refine((m) => m[m.length - 1].role === "user", "The last message must be from the user"),
});

// Stable system prompt (no timestamps) so it caches across requests.
const SYSTEM_PROMPT = `You are the malaria data analyst for Bangladesh's National Malaria Elimination Programme dashboard.

You answer questions using ONLY the tools, which query the programme's data warehouse:
- NMEP MIS monthly surveillance by upazila (2012 onward; "Central Reporting" is NMEP central testing, filed under Dhaka / Banani Thana): confirmed cases (P. falciparum, P. vivax, mixed), persons tested, deaths, severe/uncomplicated, treated, referred, sex, pregnancy, age groups, active vs passive case detection.
- ERA5 reanalysis weather per district (temperature, rainfall, humidity, dew point, soil moisture, wind).
- Model forecasts of monthly cases and deaths with back-tested accuracy.
- Automatic alerts for deaths and sudden case surges.

- Population at risk (BBS Census 2022 for 77 upazilas in 13 districts, projected yearly) and National Strategic Plan targets (cases, API, deaths, ABER, tests, commodities) imported from the NSP quantification workbook.

Definitions: TPR = cases ÷ tested × 100. API = cases per 1,000 population at risk per year; ABER = people tested per 100 population at risk per year — both use the imported population, which covers the 13 at-risk districts only. Case fatality = deaths ÷ cases × 100. Chattogram = Chittagong (the MIS uses older spellings).
Whenever you use population, API, ABER or NSP targets, name the source workbook file returned by the tools.

How to answer:
- Call data_overview first when you need to know the latest data month or what exists.
- Always state the area, period, and the numbers you used; give percentages with context (e.g. vs the previous year).
- When a forecast is involved, name the model and its back-tested accuracy exactly as returned and give the uncertainty range. Never claim more accuracy than the tool reports.
- Correlations with weather are associations, not proof of causation.
- If the data cannot answer the question, say what is missing. Do not invent figures.
- Keep answers concise and use Markdown (short headings, bullet lists, bold key numbers). You may give programme-level public-health interpretation, but not individual medical advice.`;

const hits = new Map<string, number[]>();
function rateLimited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT_PER_MINUTE;
}

const json = (value: unknown) => JSON.stringify(value, null, 0);

function buildTools() {
  const level = z.enum(["national", "division", "district", "upazila"]);
  return [
    betaZodTool({
      name: "data_overview",
      description: "Latest data month, last-12-month national totals and change, top districts, and which weather/forecast/alert data exist.",
      inputSchema: z.object({}),
      run: async () => json(await dataOverview()),
    }),
    betaZodTool({
      name: "malaria_stats",
      description:
        "Aggregated malaria surveillance figures (cases, species, tests, TPR, deaths, severe, treatment, sex, pregnancy, age groups, detection mode) for Bangladesh or one division/district/upazila, for a year range, optionally specific calendar months, grouped by nothing, year, month, or child area (for rankings).",
      inputSchema: z.object({
        area: z.string().optional().describe("Division, district or upazila name; omit for all Bangladesh"),
        level: level.optional().describe("Disambiguates names used at several levels, e.g. Chittagong district vs division"),
        year_from: z.number().int().optional(),
        year_to: z.number().int().optional(),
        months: z.array(z.number().int().min(1).max(12)).optional(),
        group_by: z.enum(["none", "year", "month", "area"]).optional(),
        rank_level: z.enum(["division", "district", "upazila"]).optional().describe("With group_by area: rank at this level, e.g. all districts nationally"),
        sort_by: z.enum(["cases", "deaths", "tests", "tpr_pct", "pf_share_pct"]).optional().describe("With group_by area: ranking metric (default cases)"),
        top: z.number().int().min(1).max(60).optional().describe("Row limit when group_by is area (sorted by cases)"),
      }),
      run: async (i) =>
        json(
          await malariaStats({
            area: i.area, level: i.level, yearFrom: i.year_from, yearTo: i.year_to, months: i.months,
            groupBy: i.group_by, rankLevel: i.rank_level, sortBy: i.sort_by, top: i.top,
          }),
        ),
    }),
    betaZodTool({
      name: "forecast",
      description: "Stored monthly forecast (point + 80%/95% intervals) of cases or deaths for Bangladesh, a division or a district, with the chosen model and its back-tested accuracy.",
      inputSchema: z.object({ area: z.string().optional(), target: z.enum(["cases", "deaths"]).optional() }),
      run: async (i) => json(await getForecast(i)),
    }),
    betaZodTool({
      name: "weather",
      description: "ERA5 monthly or yearly weather for Bangladesh, a division or a district.",
      inputSchema: z.object({
        area: z.string().optional(),
        year_from: z.number().int().optional(),
        year_to: z.number().int().optional(),
        group_by: z.enum(["month", "year"]).optional(),
      }),
      run: async (i) => json(await getWeather({ area: i.area, yearFrom: i.year_from, yearTo: i.year_to, groupBy: i.group_by })),
    }),
    betaZodTool({
      name: "climate_correlation",
      description: "Lagged (0–3 month) Spearman correlations between monthly malaria cases and rainfall, temperature, humidity, dew point and soil moisture.",
      inputSchema: z.object({ area: z.string().optional(), year_from: z.number().int().optional() }),
      run: async (i) => json(await climateCorrelation({ area: i.area, yearFrom: i.year_from })),
    }),
    betaZodTool({
      name: "population_and_nsp_targets",
      description:
        "Population at risk and National Strategic Plan targets vs actual and model forecast, per year (population, cases, API, ABER, tests, deaths) for the 13 at-risk districts or one district, with the source workbook file name.",
      inputSchema: z.object({ district: z.string().optional().describe("District name; omit for the 13 at-risk districts (NSP national)") }),
      run: async (i) => json(await nspComparison(i)),
    }),
    betaZodTool({
      name: "recent_alerts",
      description: "Most recent automatic alerts (deaths and sudden case surges) with the rules used.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
      run: async (i) => json(await recentAlerts(i)),
    }),
  ];
}

function textStream(producer: (write: (chunk: string) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await producer((chunk) => controller.enqueue(encoder.encode(chunk)));
      } catch (err) {
        const message =
          err instanceof Anthropic.AuthenticationError ? "The Anthropic API key is invalid."
          : err instanceof Anthropic.RateLimitError ? "The AI service is rate limited — please try again in a minute."
          : err instanceof Anthropic.APIError ? `AI service error (${err.status}).`
          : err instanceof Error ? err.message : "Unexpected error.";
        controller.enqueue(encoder.encode(`\n\n**Error:** ${message}`));
      } finally {
        controller.close();
      }
    },
  });
}

export async function GET() {
  return Response.json({ mode: process.env.ANTHROPIC_API_KEY ? "claude" : "offline", model: process.env.ANTHROPIC_API_KEY ? MODEL : null });
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(ip)) return new Response("Too many questions — please wait a minute.", { status: 429 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response("Invalid request.", { status: 400 });
  const { messages } = parsed.data;
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

  if (!process.env.ANTHROPIC_API_KEY) {
    const question = messages[messages.length - 1].content;
    return new Response(textStream(async (write) => write(await answerOffline(question))), { headers: { ...headers, "x-assistant-mode": "offline" } });
  }

  const client = new Anthropic();
  const stream = textStream(async (write) => {
    const runner = client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: buildTools(),
      messages,
      max_iterations: 10,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      stream: true,
    });
    for await (const messageStream of runner) {
      for await (const event of messageStream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") write(event.delta.text);
      }
      const message = await messageStream.finalMessage();
      if (message.stop_reason === "tool_use") write("\n\n");
      if (message.stop_reason === "refusal") write("\n\n_The AI declined to answer this request._");
    }
  });
  return new Response(stream, { headers: { ...headers, "x-assistant-mode": "claude" } });
}
