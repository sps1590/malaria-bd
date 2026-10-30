import { z } from "zod";
import { METRIC_BY_KEY } from "@/lib/analyst/catalog";
import { analyze } from "@/lib/analyst/engine";
import { getBounds } from "@/lib/analyst/store";
import { plabel } from "@/lib/analyst/time";
import type { AnalystContext, AnalystEvent } from "@/lib/analyst/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const RATE_LIMIT_PER_MINUTE = 30;
const GROUPS = new Set(["none", "year", "quarter", "month", "calmonth", "division", "district", "upazila"]);

const Body = z.object({
  question: z.string().trim().min(1).max(600),
  context: z
    .object({
      intent: z.string().max(30),
      metrics: z.array(z.string().max(40)).max(12),
      areas: z.array(z.string().max(200)).max(8),
      time: z
        .object({ from: z.number().int(), to: z.number().int(), months: z.array(z.number().int().min(1).max(12)).max(12).optional(), label: z.string().max(160) })
        .nullable(),
      group: z.string().max(20).nullable(),
    })
    .nullable()
    .optional(),
});

const hits = new Map<string, number[]>();
function rateLimited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT_PER_MINUTE;
}

/** The client only echoes back what a previous reply gave it, but never trust it: keep known keys only. */
function sanitizeContext(c: z.infer<typeof Body>["context"]): AnalystContext | null {
  if (!c) return null;
  return {
    intent: c.intent,
    metrics: c.metrics.filter((k) => METRIC_BY_KEY.has(k)),
    areas: c.areas,
    time: c.time,
    group: c.group && GROUPS.has(c.group) ? c.group : null,
  };
}

export async function GET() {
  try {
    const b = await getBounds();
    return Response.json({ ready: true, mode: "free-readonly", years: `${b.firstYear}–${b.lastYear}`, latest: plabel(b.latestP), rows: b.rows });
  } catch {
    return Response.json({ ready: false, mode: "free-readonly" });
  }
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(ip)) return Response.json({ error: "Too many questions — please wait a minute." }, { status: 429 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
  const { question } = parsed.data;
  const context = sanitizeContext(parsed.data.context);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AnalystEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const reply = await analyze(question, context, (label) => send({ t: "step", label }));
        send({ t: "reply", reply });
      } catch (err) {
        console.error("[analyst]", err);
        const message = err instanceof Error && /DATABASE_URL/.test(err.message)
          ? "The database is not configured on this server."
          : "I hit a problem while querying the data. Please try rephrasing, or ask again in a moment.";
        send({ t: "error", message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
