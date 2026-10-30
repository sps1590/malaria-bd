/**
 * The analyst's brain: question (+ previous turn) → understanding → read-only queries → a written answer
 * with a table, a chart, the SQL used and follow-up suggestions. Free, deterministic, no external AI.
 */
import { getLookup, suggestPlaces, type AreaLookup } from "./areas";
import { CAPABILITIES, STARTERS } from "./catalog";
import { pretty, unitWord } from "./format";
import { READ_ONLY_REPLY, RAW_SQL_REPLY } from "./guard";
import * as H from "./handlers";
import { parse, type Intent, type Parsed } from "./nlu";
import { newLog, type RunLog } from "./query";
import { planStats, presentStats, runStats, type StatsPlan } from "./stats";
import { getBounds, type Bounds } from "./store";
import { joinList } from "./text";
import { labelRange } from "./time";
import type { AnalystContext, AnalystReply } from "./types";

type Step = (label: string) => void;

const INTENT_LABEL: Record<Intent, string> = {
  stats: "Statistics", brief: "Situation brief", explain: "Why-analysis", forecast: "Forecast", weather: "Weather", climate: "Climate link",
  alerts: "Alerts", signals: "Unusual-rise check", nsp: "NSP targets", population: "Population", list: "List", glossary: "Definition",
  about: "About", meta: "Data info", greeting: "Hello", thanks: "Thanks", refuse: "Read-only", rawsql: "Plain language", clarify: "Not understood",
};

const WRITE_EXAMPLES = ["Which districts had the most cases in 2025?", "Monthly deaths in Cox's Bazar since 2020", "Districts with fewer than 1,000 tests in 2025"];

function chips(p: Parsed, plan?: StatsPlan): AnalystReply["interpretation"] {
  const out: AnalystReply["interpretation"] = [{ label: "Task", value: INTENT_LABEL[p.intent] }];
  if (plan) {
    out.push({ label: "Measure", value: plan.metrics.slice(0, 4).map((m) => m.label).join(", ") + (plan.metrics.length > 4 ? "…" : "") });
    out.push({ label: "Area", value: plan.areas.length ? joinList(plan.areas.map((a) => a.label)) : "Bangladesh" });
    out.push({ label: "Period", value: plan.timeAssumed ? `${plan.timeLabel.replace(/ \(last .*\)$/, "")} · assumed` : plan.timeLabel });
    if (plan.group !== "none") out.push({ label: "Grouped by", value: plan.group === "calmonth" ? "calendar month" : plan.group });
    if (plan.having.length) out.push({ label: "Filter", value: plan.having.map((h) => h.text).join(" and ") });
    if (plan.avgMonthly) out.push({ label: "Aggregation", value: "average per month" });
    if (plan.shift !== null) out.push({ label: "Compared with", value: plan.prefix + labelRange(plan.from - plan.shift, plan.to - plan.shift, plan.to) });
  } else {
    if (p.metrics.length) out.push({ label: "Measure", value: p.metrics.join(", ") });
    out.push({ label: "Area", value: p.areas.length ? joinList(p.areas.map((a) => a.label)) : "Bangladesh" });
    if (p.time) out.push({ label: "Period", value: p.time.label });
  }
  if (p.inherited.length) out.push({ label: "From your last question", value: p.inherited.join(", ") });
  return out;
}

function contextOf(p: Parsed, plan?: StatsPlan, bounds?: Bounds): AnalystContext {
  const keepTime = plan ? { from: plan.from, to: plan.to, months: plan.months, label: plan.timeLabel } : p.time && p.time.from >= 0 ? { from: p.time.from, to: p.time.to, months: p.time.months, label: p.time.label } : null;
  void bounds;
  return {
    intent: p.intent,
    metrics: plan ? plan.metrics.map((m) => m.key).slice(0, 8) : p.metrics,
    areas: (plan ? plan.areas : p.areas).map((a) => a.ref),
    time: keepTime,
    group: plan ? plan.group : p.group,
  };
}

function reply(base: Partial<AnalystReply> & { text: string }, log: RunLog, t0: number): AnalystReply {
  return {
    kind: "answer", sql: log.sql, interpretation: [], suggestions: [], context: null, ms: Date.now() - t0, rowCount: log.rows, ...base,
  };
}

function clarify(p: Parsed, lk: AreaLookup, t0: number, log: RunLog): AnalystReply {
  const suggestions: string[] = [];
  let text: string;
  if (p.unknownPlaces.length) {
    const w = p.unknownPlaces[0];
    const shown = p.original.match(new RegExp(w, "i"))?.[0] ?? w;
    const near = suggestPlaces(lk, w).map(pretty);
    text = `I couldn't find a place called **“${shown}”** in the surveillance data.${near.length ? ` Did you mean ${joinList(near.map((n) => `**${n}**`), "or")}?` : ""}\n\nI know all ${lk.index.divisions.length} divisions, ${lk.index.districts.length} districts and ${lk.index.upazilas.length} upazilas that report to the MIS — try one of those, or ask about “Bangladesh” as a whole.`;
    for (const n of near.slice(0, 3)) suggestions.push(p.original.replace(new RegExp(w, "i"), n));
    if (!suggestions.length) suggestions.push(...STARTERS.slice(0, 3).map((s) => s.prompts[0]));
  } else {
    text = `I wasn't sure what to look up. To answer I need (any combination of):\n\n- a **measure** — cases, deaths, tests, test positivity, species, age, sex…\n- a **place** — a division, district or upazila (or “Bangladesh”, “the endemic districts”)\n- a **period** — “2025”, “last 6 months”, “since 2020”, “March 2025”\n\nFor example: *“Cases and deaths in Cox's Bazar by month in 2025”* or *“Top 10 upazilas by cases”*.`;
    suggestions.push(...STARTERS.slice(0, 4).map((s) => s.prompts[0]));
  }
  return reply({ kind: "clarify", text, suggestions: suggestions.slice(0, 4), interpretation: chips(p), context: null }, log, t0);
}

export async function analyze(question: string, ctx: AnalystContext | null, step: Step): Promise<AnalystReply> {
  const t0 = Date.now();
  const log = newLog();
  step("Reading your question");
  const [bounds, lk] = await Promise.all([getBounds(), getLookup()]);
  const p = parse(question, ctx, lk, bounds);
  const finish = (part: H.Part, plan?: StatsPlan, extraChips?: AnalystReply["interpretation"]): AnalystReply => {
    const partChips = (): AnalystReply["interpretation"] => {
      const c = chips(p, plan);
      if (plan) return c;
      return c.filter((x) => x.label !== "Area" && x.label !== "Period").concat(part.scope ? [{ label: "Area", value: part.scope }] : p.areas.length ? [{ label: "Area", value: joinList(p.areas.map((a) => a.label)) }] : [{ label: "Area", value: "Bangladesh" }], part.period ? [{ label: "Period", value: part.period }] : p.time ? [{ label: "Period", value: p.time.label }] : []);
    };
    const italic = (n: string) => `_${n.replace(/\*\*/g, "")}_`;
    const prefix = p.notes.filter((n) => n.startsWith("I read")).map(italic).join("\n");
    const other = p.notes.filter((n) => !n.startsWith("I read") && !part.text.includes(n) && !(p.intent === "alerts" && n.startsWith("“Recent”"))).map(italic).join("\n");
    const text = [prefix, part.text, other].filter(Boolean).join("\n\n");
    return reply(
      { kind: part.kind ?? "answer", text, table: part.table, chart: part.chart, suggestions: part.suggestions, interpretation: extraChips ?? partChips(), context: contextOf(p, plan, bounds) },
      log,
      t0,
    );
  };

  switch (p.intent) {
    case "refuse":
      return reply({ kind: "refusal", text: `${READ_ONLY_REPLY}\n\n${WRITE_EXAMPLES.map((e) => `- ${e}`).join("\n")}`, suggestions: WRITE_EXAMPLES, interpretation: [{ label: "Task", value: "Read-only" }], context: ctx }, log, t0);
    case "rawsql":
      return reply({ kind: "refusal", text: `${RAW_SQL_REPLY}\n\n${WRITE_EXAMPLES.map((e) => `- ${e}`).join("\n")}`, suggestions: WRITE_EXAMPLES, interpretation: [{ label: "Task", value: "Plain language" }], context: ctx }, log, t0);
    case "greeting":
      return { ...finish(H.greeting(), undefined, []), context: ctx };
    case "thanks":
      return { ...finish(H.thanks(), undefined, []), context: ctx };
    case "about":
      return { ...finish(H.about(), undefined, []), context: ctx };
    case "glossary":
      return finish(H.glossary(p.glossary!), undefined, [{ label: "Task", value: "Definition" }]);
    case "clarify":
      return clarify(p, lk, t0, log);
    default:
      break;
  }

  // a place name we don't know must never silently turn into a national answer
  if (p.unknownPlaces.length && !p.areas.length && !p.nationalCue && ["stats", "brief", "explain", "forecast", "weather", "climate", "signals", "nsp"].includes(p.intent)) {
    return clarify(p, lk, t0, log);
  }

  if (p.intent === "list") { step("Looking up the area list"); return finish(H.list(p, lk)); }
  if (p.intent === "meta") { step("Checking what data is loaded"); return finish(await H.meta(bounds, lk)); }

  step(`Understood — ${INTENT_LABEL[p.intent].toLowerCase()}${p.areas.length ? ` · ${joinList(p.areas.map((a) => a.label))}` : ""}`);

  if (p.intent === "stats") {
    const plan = planStats(p, bounds);
    step(`Querying the database (read-only) · ${plan.perArea ? plan.areas.length : 1} ${plan.perArea ? "queries" : "query set"}`);
    const bundles = await runStats(plan, log);
    step("Writing the answer");
    const pres = presentStats(plan, bundles, p, bounds.latestP);
    void unitWord;
    return finish({ text: pres.text, table: pres.table, chart: pres.chart, suggestions: pres.suggestions }, plan);
  }

  step("Querying the database (read-only)");
  let part: H.Part;
  switch (p.intent) {
    case "brief": part = await H.brief(p, bounds, log); break;
    case "explain": part = await H.explain(p, bounds, log); break;
    case "signals": part = await H.signals(p, bounds, log); break;
    case "forecast": part = await H.forecast(p, bounds, log); break;
    case "weather": part = await H.weather(p, bounds, log); break;
    case "climate": part = await H.climate(p, bounds, log); break;
    case "alerts": part = await H.alerts(p, log); break;
    case "nsp":
    case "population": part = await H.nsp(p, bounds, log); break;
    default: return clarify(p, lk, t0, log);
  }
  step("Writing the answer");
  return finish(part);
}

export { CAPABILITIES };
