/**
 * Natural-language understanding for the analyst: free text (+ the previous turn's context) → a structured
 * `Parsed` request. Rule-based, deterministic, free — no model, no API key. It extracts what was asked
 * (metrics, places, period, grouping, ranking, thresholds, comparison), decides the intent, and carries
 * context across follow-ups ("and deaths?", "what about Bandarban?", "by district").
 */
import { BREAKDOWNS, GLOSSARY, METRICS, SHARE_OF, TIME_GROUPS, type BreakdownKey, type GlossaryEntry, type GroupKey } from "./catalog";
import { findAreas, selFromRef, type AreaLookup, type AreaSel } from "./areas";
import { detectWrite } from "./guard";
import type { Bounds } from "./store";
import { blank, normalize, parseNumber } from "./text";
import { makeTime, parseTime, type TimeSel } from "./time";
import type { AnalystContext } from "./types";

export type Intent =
  | "stats" | "map" | "brief" | "explain" | "forecast" | "weather" | "climate" | "alerts" | "signals"
  | "nsp" | "population" | "list" | "glossary" | "about" | "meta" | "greeting" | "thanks"
  | "refuse" | "rawsql" | "clarify";

export interface Having {
  /** null → the primary metric. */
  metric: string | null;
  op: ">" | ">=" | "<" | "<=" | "=";
  value: number;
  /** "districts with deaths": only applied when the result is grouped by area. */
  soft?: boolean;
}

export interface Compare {
  kind: "yoy" | "mom" | "prev" | "auto" | "years";
  /** Months to shift back for kind "years". */
  shift?: number;
}

export interface Parsed {
  intent: Intent;
  original: string;
  metrics: string[];
  breakdown: BreakdownKey | null;
  areas: AreaSel[];
  nationalCue: boolean;
  time: TimeSel | null;
  group: GroupKey | null;
  /** Level named as a group ("which districts…"), even if no explicit "by". */
  groupLevel: GroupKey | null;
  rank: { dir: "desc" | "asc"; n: number | null } | null;
  having: Having[];
  agg: "sum" | "avg_monthly";
  compare: Compare | null;
  direction: "up" | "down" | null;
  share: boolean;
  peak: boolean;
  /** Month grouping came from a generic "trend"/"over time", not an explicit "monthly". */
  trendOnly: boolean;
  glossary: GlossaryEntry | null;
  listLevel: "division" | "district" | "upazila" | null;
  count: boolean;
  horizon: number | null;
  forecastTarget: "cases" | "deaths";
  notes: string[];
  unknownPlaces: string[];
  inherited: string[];
  writeReason?: "write" | "sql";
  slots: number;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ------------------------------ vocab ------------------------------ */

interface TermRe { key: string; len: number; re: RegExp }
const termRegexes = (terms: { key: string; term: string }[]): TermRe[] =>
  terms
    .map(({ key, term }) => {
      const n = normalize(term);
      return { key, len: n.length, re: new RegExp(`(?<![a-z0-9])${esc(n).replace(/\s+/g, "\\s+")}(?![a-z0-9])`) };
    })
    .sort((a, b) => b.len - a.len);

const METRIC_RES = termRegexes(METRICS.flatMap((m) => m.terms.map((term) => ({ key: m.key, term }))));
const BREAKDOWN_RES = termRegexes(
  (Object.entries(BREAKDOWNS) as [BreakdownKey, (typeof BREAKDOWNS)[BreakdownKey]][]).flatMap(([key, b]) => b.terms.map((term) => ({ key, term }))),
);
const GLOSSARY_RES = termRegexes(GLOSSARY.flatMap((g, i) => g.aliases.map((term) => ({ key: String(i), term }))));

/** Words the place-typo matcher must never treat as a misspelt place. */
const VOCAB = new Set<string>([
  ...METRICS.flatMap((m) => m.terms.flatMap((t) => normalize(t).split(/\s+/))),
  ...GLOSSARY.flatMap((g) => g.aliases.flatMap((t) => normalize(t).split(/\s+/))),
  ..."malaria bangladesh compare comparison compared versus between trend trends monthly yearly annual quarterly average highest lowest across during within through period history historical recent recently currently number numbers total overall percentage proportion increase increased decrease decreased change changed changes growth decline declined falling rising please thanks showing report reports reported reporting recorded cases deaths patients health hospital population districts divisions upazilas upazila district division thana which where what when whose could would should about there their these those other another following previous earlier later months years weeks month year week days day quarter season seasonal summer winter monsoon rainfall rainy temperature humidity weather climate forecast forecasts predict prediction alert alerts surge surges outbreak outbreaks unusual abnormal signals data database information details detail summary overview brief briefing situation profile status explain explanation reason reasons because affected affecting severe species gender children adults female male women pregnant infants since first second third fourth least most worst best top bottom list name names give tell display provide count counts rank ranked ranking compute calculate analysis analyse analyze".split(" "),
]);

/* ------------------------------ cue regexes ------------------------------ */

const RE = {
  map: /\b(?:maps?|mapped|mapping|choropleths?|heat ?maps?|geo ?maps?|gis|geographic(?:al)?(?:ly)?|spatial(?:ly)?|on the ground|where (?:are|is) (?:the )?(?:cases|malaria|hotspots?))\b/,
  greeting: /^(?:hi|hello|hey|hiya|salam|assalamu alaikum|assalamualaikum|namaste|good (?:morning|afternoon|evening)|greetings)\b[\s!.,]*(?:there|team|analyst|bot|assistant)?[\s!.,]*$/,
  thanks: /^(?:thanks|thank you|thx|ty|great|awesome|perfect|nice|cool|good job|well done|ok thanks|okay thanks|got it|brilliant|excellent|wonderful)\b[\s!.,a-z]{0,25}$/,
  about: /\b(?:what can you do|what do you do|what can i ask|who are you|what are you|your name|how do (?:i|you) use|how does this work|what (?:kind of )?(?:questions|things)|capabilities|are you (?:an? )?(?:ai|bot|human|real|robot|chatgpt|gpt|claude|llm)|which model|what model|are you free|do you cost|is this free|help)\b/,
  forecast: /\b(?:forecast\w*|predict\w*|projection\w*|projected|outlook|anticipat\w+|next (?:\d+ |one |two |three |four |six |twelve )?(?:months?|quarters?|years?)|coming (?:months?|quarters?|year)|going forward|in the future|future|will (?:there|cases|malaria|deaths|it))\b/,
  weather: /\b(?:weather|rain|rainfall|precipitation|temperature|temperatures|humidity|humid|dew ?point|soil moisture|wind|climate|climatic)\b/,
  corr: /\b(?:correlat\w*|relationship|association|associated|influenc\w*|affect\w*|impact\w*|linked?|driven by|depend\w*|relat(?:ed|ion|es)|lag(?:ged)?|explained by|effect)\b/,
  alerts: /\b(?:alerts?|alarms?|warnings?|notifications?|surge alerts?)\b/,
  signals: /\b(?:unusual\w*|abnormal\w*|anomal\w*|outbreaks?|above (?:normal|expected|average|threshold|usual)|higher than (?:normal|usual|expected|average)|spikes?|spiking|aberrations?|early warning|epidemic|exceed\w* (?:the )?(?:normal|expected|threshold|endemic|usual)|signals?|surges?|unexpected\w*)\b/,
  nsp: /\b(?:nsp|strategic plan|targets?|quantification|on track|elimination (?:goal|target)|2030)\b/,
  population: /\b(?:population|people at risk|inhabitants|residents|population at risk)\b/,
  explain: /\b(?:why|reasons?|what (?:explains|caused|drove|happened|is behind|are the drivers)|causes?|drivers?|due to|how come|behind (?:the|this)|contribut\w+|responsible|accounts? for the (?:change|drop|rise|fall|increase|decrease))\b/,
  brief: /\b(?:brief|briefing|summary|summari[sz]e|overview|situation|snapshot|profile|status|tell me about|report on|update on|state of|how is|how's|how are|how's|what(?:'s| is) (?:happening|going on)|dashboard|big picture|key (?:figures|facts|numbers|indicators))\b/,
  list: /\b(?:list|name|enumerate|show me all|which are|what are)\b/,
  meta: /\b(?:data (?:freshness|coverage|quality|source|range|period|available|until|up to)|latest data|last (?:sync|update|refresh)|when (?:was|is|were).{0,30}(?:updat\w*|sync\w*|refresh\w*|collect\w*)|how (?:recent|fresh|current|old|up to date)|what (?:data|years|period|months|time range)|which years|how many (?:records|rows|reports|months|years)|since when|how far back|data starts?|data ends?|what do you have)\b/,
  yoy: /\b(?:year[- ]?(?:on|over)[- ]?year|yoy|y-o-y)\b/,
  mom: /\b(?:month[- ]?(?:on|over)[- ]?month|mom|m-o-m)\b/,
  compareLast: /\b(?:compared?(?: (?:to|with))?|vs\.?|versus|against|relative to|than|from|since|over|versus)\s+(?:the\s+)?(?:same\s+(?:period|month|time|months)\s+)?(?:in\s+)?(last|previous|prior|preceding|earlier)\s+(year|month|quarter|period)\b/,
  compareCue: /\b(?:compare[ds]?|comparison|vs\.?|versus|against|relative to|than)\b/,
  changeCue: /\b(?:chang(?:e|ed|es|ing)|increas\w*|decreas\w*|ris(?:e|en|ing)|rose|fell|fall(?:en|ing)?|drop(?:ped|s)?|declin\w*|grew|grow\w*|growth|reduc\w*|improv\w*|worsen\w*|jump\w*|surg(?:e|ed|es|ing)|trending (?:up|down))\b/,
  up: /\b(?:increas\w*|ris(?:e|en|ing)|rose|grew|grow\w*|growth|jump\w*|worsen\w*|surg(?:e|ed|es|ing)|climb\w*)\b/,
  down: /\b(?:decreas\w*|fell|fall(?:en|ing)?|drop(?:ped|s)?|declin\w*|reduc\w*|improv\w*)\b/,
  avg: /\b(?:average|avg|mean|typical(?:ly)?|on average)\b/,
  perMonth: /\b(?:per month|a month|each month|monthly|every month)\b/,
  share: /\b(?:share|percent(?:age)? of|proportion|contribution|contribute[sd]?|fraction|how much of)\b/,
  peak: /\b(?:peak\w*|busiest|worst (?:month|year|quarter|season)|highest (?:month|year|quarter)|lowest (?:month|year|quarter)|high season|low season|peak season|which (?:month|year|quarter)s?|what (?:month|year|quarter)|when (?:was|were|is|did|do|does|will)|time of (?:the )?year)\b/,
  rankDesc: /\b(?:top|highest|most|largest|biggest|worst|hotspots?|leading|maximum|max|greatest|heaviest|hardest hit|rank(?:ed|ing|s)?|burden(?:ed)?)\b/,
  rankAsc: /\b(?:lowest|least|fewest|smallest|minimum|min|bottom|best|safest|lightest)\b/,
};

const LEVEL_PLURAL: [GroupKey, RegExp][] = [
  ["division", /\bdivisions\b/],
  ["district", /\b(?:districts|zilas|zillas)\b/],
  ["upazila", /\b(?:upazilas|upazillas|thanas)\b/],
];
const LEVEL_BY: [GroupKey, RegExp][] = [
  ["division", /\b(?:by|per|each|every|across|among|for each|wise|breakdown by|split by)\s+(?:the\s+)?divisions?\b|\bdivision[- ]?wise\b/],
  ["district", /\b(?:by|per|each|every|across|among|for each|wise|breakdown by|split by)\s+(?:the\s+)?(?:districts?|zilas?)\b|\bdistrict[- ]?wise\b/],
  ["upazila", /\b(?:by|per|each|every|across|among|for each|wise|breakdown by|split by)\s+(?:the\s+)?(?:upazilas?|upazillas?|thanas?)\b|\b(?:upazila|thana)[- ]?wise\b/],
];
/** "district-level", "at upazila level", "division map" */
const LEVEL_AT: [GroupKey, RegExp][] = [
  ["division", /\bdivision[- ]level\b|\bat (?:the )?division level\b|\bdivision (?:map|heat ?map)\b/],
  ["district", /\bdistrict[- ]level\b|\bat (?:the )?district level\b|\bdistrict (?:map|heat ?map)\b/],
  ["upazila", /\b(?:upazila|upazilla|thana)[- ]level\b|\bat (?:the )?(?:upazila|upazilla|thana) level\b|\b(?:upazila|upazilla|thana) (?:map|heat ?map)\b/],
];
const LEVEL_WHICH: [GroupKey, RegExp][] = [
  ["division", /\b(?:which|what)\s+(?:is\s+the\s+|are\s+the\s+)?divisions?\b/],
  ["district", /\b(?:which|what)\s+(?:is\s+the\s+|are\s+the\s+)?districts?\b/],
  ["upazila", /\b(?:which|what)\s+(?:is\s+the\s+|are\s+the\s+)?(?:upazilas?|upazillas?|thanas?)\b/],
];
const TIME_GROUP_CUES: [GroupKey, RegExp][] = [
  ["quarter", /\b(?:quarterly|by quarter|per quarter|each quarter|every quarter|quarter by quarter|quarter[- ]?wise)\b/],
  ["year", /\b(?:yearly|annual(?:ly)?|by year|per year|each year|every year|year by year|year[- ]?wise|over the years|by years)\b/],
  ["calmonth", /\b(?:seasonal(?:ity)?|time of (?:the )?year|calendar month|month of (?:the )?year|months of (?:the )?year|peak season|by season|seasonal pattern|which months? of)\b/],
  ["month", /\b(?:monthly|by month|per month|each month|every month|month by month|month[- ]?wise|trends?|over time|time series|timeline|progress|evolution|trajectory|movement)\b/],
];

const NUM = "\\d[\\d,]*(?:\\.\\d+)?\\s?k?";
const OPS: [Having["op"], string][] = [
  [">=", "at least|min(?:imum)?(?: of)?|not less than|>=|no fewer than"],
  ["<=", "at most|max(?:imum)?(?: of)?|no more than|not more than|<="],
  [">", "more than|greater than|bigger than|higher than|larger than|over|above|exceed(?:ing|s)?|>"],
  ["<", "fewer than|less than|lower than|smaller than|under|below|<"],
  ["=", "exactly|equal(?:s)? to|equals?|="],
];
const THRESHOLD_RE = new RegExp(`(?<![a-z0-9])(${OPS.map(([, p]) => `(?:${p})`).join("|")})\\s*(${NUM})(?![a-z0-9])`, "g");
const opOf = (word: string): Having["op"] => {
  for (const [op, pat] of OPS) if (new RegExp(`^(?:${pat})$`).test(word)) return op;
  return ">";
};

interface Span { key: string; start: number; end: number }

function matchTerms(text: string, res: TermRe[]): { spans: Span[]; rest: string } {
  let t = text;
  const spans: Span[] = [];
  for (const { key, re } of res) {
    for (;;) {
      const m = re.exec(t);
      if (!m) break;
      spans.push({ key, start: m.index, end: m.index + m[0].length });
      t = blank(t, m.index, m.index + m[0].length);
    }
  }
  return { spans: spans.sort((a, b) => a.start - b.start), rest: t };
}

/* ------------------------------ parse ------------------------------ */

export function parse(raw: string, ctx: AnalystContext | null, lk: AreaLookup, bounds: Bounds): Parsed {
  const original = raw.trim();
  let t = normalize(original);
  const p: Parsed = {
    intent: "clarify", original, metrics: [], breakdown: null, areas: [], nationalCue: false, time: null, group: null,
    groupLevel: null, rank: null, having: [], agg: "sum", compare: null, direction: null, share: false, peak: false, trendOnly: false,
    glossary: null, listLevel: null, count: false, horizon: null, forecastTarget: "cases", notes: [], unknownPlaces: [],
    inherited: [], slots: 0,
  };

  // ---- safety first
  const guard = detectWrite(t, original);
  if (guard.blocked) {
    p.intent = guard.reason === "sql" ? "rawsql" : "refuse";
    p.writeReason = guard.reason;
    return p;
  }

  // ---- small talk
  const wordCount = t.split(" ").filter(Boolean).length;
  if (RE.greeting.test(t)) return { ...p, intent: "greeting" };
  if (RE.thanks.test(t)) return { ...p, intent: "thanks" };
  if (RE.about.test(t) && wordCount <= 12) return { ...p, intent: "about" };

  // ---- comparison phrases that contain a time word ("vs last year") must be read before the time parser eats them
  const mLast = RE.compareLast.exec(t);
  if (mLast) {
    const unit = mLast[2];
    p.compare = { kind: unit === "month" ? "mom" : unit === "period" || unit === "quarter" ? "prev" : "yoy" };
    t = blank(t, mLast.index, mLast.index + mLast[0].length);
  }
  const mYoy = RE.yoy.exec(t);
  if (mYoy) { p.compare = { kind: "yoy" }; t = blank(t, mYoy.index, mYoy.index + mYoy[0].length); }
  const mMom = RE.mom.exec(t);
  if (mMom) { p.compare = { kind: "mom" }; t = blank(t, mMom.index, mMom.index + mMom[0].length); }

  // ---- "how many upazilas/districts had cases"
  const manyAreas = /\bhow many\s+(upazilas?|upazillas?|thanas?|districts?)\s+(?:had|have|has|reported|recorded|with|saw|are affected|were affected|reporting|that (?:had|reported|recorded))\s*(?:any\s+)?(cases?)?/.exec(t);
  if (manyAreas) {
    p.metrics.push(manyAreas[1].startsWith("district") ? "districts_with_cases" : "upazilas_with_cases");
    t = blank(t, manyAreas.index, manyAreas.index + manyAreas[0].length);
  }

  // ---- time
  const tp = parseTime(t, bounds.latestP, bounds.firstYear);
  t = tp.rest;
  p.time = tp.sel;
  p.notes.push(...tp.notes);

  // ---- metrics (keep positions for threshold binding)
  const metricMatch = matchTerms(t, METRIC_RES);
  const breakdownMatch = matchTerms(metricMatch.rest, BREAKDOWN_RES);
  const glossaryMatch = matchTerms(t, GLOSSARY_RES);
  for (const s of metricMatch.spans) if (!p.metrics.includes(s.key)) p.metrics.push(s.key);
  if (breakdownMatch.spans.length) p.breakdown = breakdownMatch.spans[0].key as BreakdownKey;
  // "what percentage of cases are falciparum" → the falciparum-share metric (not "cases" plus "falciparum")
  if (RE.share.test(t) && !p.breakdown) {
    const shares = p.metrics.filter((k) => SHARE_OF[k]);
    if (shares.length) {
      p.metrics = [...new Set(p.metrics.filter((k) => k !== "cases" && !SHARE_OF[k]).concat(shares.map((k) => SHARE_OF[k])))];
    }
  }

  // ---- thresholds ("more than 100 cases", "no deaths", "districts with deaths")
  const claimed: [number, number][] = metricMatch.spans.map((s) => [s.start, s.end]);
  for (const m of t.matchAll(THRESHOLD_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (claimed.some(([a, b]) => start < b && end > a)) continue; // "over 15" (adults) etc.
    const value = parseNumber(m[2].replace(/\s+/g, ""));
    if (value === null) continue;
    if (/^(?:19|20)\d\d$/.test(String(value))) continue;
    const after = metricMatch.spans.find((s) => s.start >= end && s.start - end <= 20);
    const before = [...metricMatch.spans].reverse().find((s) => s.end <= start && start - s.end <= 20);
    p.having.push({ metric: (after ?? before)?.key ?? null, op: opOf(m[1]), value });
    t = blank(t, start, end);
  }
  for (const s of metricMatch.spans) {
    const lead = t.slice(Math.max(0, s.start - 26), s.start);
    if (/\b(?:no|zero|without|nil|not a single)\s+(?:reported\s+|recorded\s+|any\s+)?$/.test(lead)) {
      p.having.push({ metric: s.key, op: "=", value: 0 });
    } else if (!p.having.some((h) => h.metric === s.key && !h.soft) && /\b(?:with|had|having|reporting|reported|recorded|where there (?:were|was))\s+(?:any\s+|at least one\s+|some\s+)?$/.test(lead)) {
      p.having.push({ metric: s.key, op: ">", value: 0, soft: true });
    }
  }

  // ---- places
  const ignore = new Set<string>(VOCAB);
  for (const s of [...metricMatch.spans, ...breakdownMatch.spans]) ignore.add(t.slice(s.start, s.end));
  const looseUpazila = /\b(?:upazilas?|upazillas?|thanas?)\b/.test(t) && !/\b(?:upazilas|upazillas|thanas)\b/.test(t);
  const found = findAreas(lk, t, looseUpazila, original, ignore);
  p.areas = found.areas;
  p.notes.push(...found.notes);
  p.unknownPlaces = found.unknown;
  t = found.rest;
  p.nationalCue = /\b(?:bangladesh|national(?:ly)?|countrywide|nationwide|whole country|entire country|all of bangladesh|across the country|all districts|all divisions|every district)\b/.test(t);

  // ---- glossary ("what is TPR")
  const defCue = /^(?:what(?:'s| is| are| does| do)?|whats|define|definition of|meaning of|explain|describe|tell me about|what do you mean by)\b|\bmean(?:s|ing)?\b|\bstands? for\b/.test(t);
  if (defCue && glossaryMatch.spans.length && !p.areas.length && !p.time && !p.having.length && !RE.explain.test(t)) {
    p.glossary = GLOSSARY[Number(glossaryMatch.spans[0].key)];
    p.intent = "glossary";
    return p;
  }

  // ---- grouping
  const hasAvg = RE.avg.test(t) && RE.perMonth.test(t);
  if (hasAvg) p.agg = "avg_monthly";
  for (const [g, re] of LEVEL_BY) if (re.test(t)) { p.group = g; break; }
  if (!p.group) for (const [g, re] of LEVEL_AT) if (re.test(t)) { p.group = g; break; }
  if (!p.group) for (const [g, re] of LEVEL_WHICH) if (re.test(t)) { p.group = g; p.groupLevel = g; break; }
  if (!p.group) {
    for (const [g, re] of TIME_GROUP_CUES) {
      if (g === "month" && hasAvg) continue;
      if (re.test(t)) { p.group = g; break; }
    }
  }
  p.trendOnly = !p.peak && p.group === "month" && !/\b(?:monthly|by month|per month|each month|every month|month by month|month[- ]?wise)\b/.test(t);
  if (!p.group) for (const [g, re] of LEVEL_PLURAL) if (re.test(t)) { p.groupLevel = g; break; }
  // "is malaria getting better or worse?" / "are cases rising?" → the recent monthly trend
  if (!p.group && !p.groupLevel && /\b(?:getting|becoming|going|trending|looking)\s+(?:better|worse|up|down)\b|\bimproving\b|\bworsening\b|\bdeteriorating\b|\bany (?:improvement|progress)\b|\b(?:cases|deaths|malaria|it)\s+(?:is |are )?(?:rising|falling|increasing|decreasing|declining|growing)\b/.test(t)) {
    p.group = "month";
    p.trendOnly = true;
  }
  if (/\b(?:which|what)\s+(?:areas?|places?|regions?|locations?|spots?)\b|\bhotspots?\b/.test(t) && !p.group && !p.groupLevel) p.groupLevel = "district";

  // ---- ranking
  const topN = /\b(?:top|bottom|first|highest|lowest|worst|best)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\b|\b(\d+)\s+(?:highest|lowest|worst|best|most|least|top|bottom)\b/.exec(t);
  const asc = RE.rankAsc.test(t);
  const desc = RE.rankDesc.test(t);
  if (asc || desc) p.rank = { dir: asc ? "asc" : "desc", n: topN ? (parseNumber(topN[1] ?? topN[2]) ?? null) : null };
  else if (topN) p.rank = { dir: "desc", n: parseNumber(topN[1] ?? topN[2]) };

  // ---- period comparison / direction
  const years = p.time?.years ?? [];
  const distinctYears = [...new Set(years)].sort((a, b) => a - b);
  if (!p.compare && distinctYears.length === 2 && (RE.compareCue.test(t) || /\band\b/.test(t)) && p.time && p.time.from >= 0) {
    // "2025 vs 2024": base = later year, compared with the earlier one
    const [early, late] = distinctYears;
    if (RE.compareCue.test(t)) {
      p.compare = { kind: "years", shift: (late - early) * 12 };
      p.time = makeTime(Math.max(p.time.from, (late * 12)), Math.min(p.time.to, late * 12 + 11), bounds.latestP, { months: p.time.months, years: distinctYears });
    }
  }
  if (RE.up.test(t) && !RE.down.test(t)) p.direction = "up";
  else if (RE.down.test(t) && !RE.up.test(t)) p.direction = "down";
  if (!p.compare && RE.changeCue.test(t) && (p.time || p.rank || p.groupLevel || p.group)) p.compare = { kind: "auto" };
  if (!p.compare && RE.changeCue.test(t) && RE.compareCue.test(t)) p.compare = { kind: "auto" };

  p.share = RE.share.test(t);
  p.peak = RE.peak.test(t) || /\b(?:highest|lowest|most|largest|biggest|maximum|record(?:ed)?|worst)\b.{0,50}\b(?:in|per|during) (?:a|one|any) (?:single )?(?:month|year|quarter)\b/.test(t);
  if (p.peak && !p.group) {
    const usually = /\b(?:usually|typically|normally|generally|of the year|season|each year|every year|historically)\b/.test(t);
    const unit = /\b(month|year|quarter)\b/.exec(t)?.[1];
    p.group = unit === "year" ? "year" : unit === "quarter" ? "quarter" : usually || !p.time ? "calmonth" : "month";
    if (!p.rank) p.rank = { dir: /\b(?:lowest|least|fewest|minimum|best)\b/.test(t) ? "asc" : "desc", n: null };
  }

  // ---- count / list
  const listLevel = /\b(divisions|districts|upazilas|upazillas|thanas)\b/.exec(t)?.[1];
  const level = listLevel ? (listLevel.startsWith("division") ? "division" : listLevel.startsWith("district") ? "district" : "upazila") : null;
  p.count = /\b(?:how many|number of|count of|total number of)\b/.test(t);
  const noData = !p.metrics.length && !p.breakdown && !p.rank && !p.having.length && !p.time;
  if (level && noData && (p.count || RE.list.test(t) || /\b(?:in|of|under)\b/.test(t)) && !/\b(?:cases|deaths|reported|affected)\b/.test(t)) {
    p.listLevel = level;
  }

  p.forecastTarget = /\bdeaths?\b|\bmortality\b/.test(t) ? "deaths" : "cases";
  const hz = /\bnext\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(months?|quarters?|years?)\b/.exec(t);
  if (hz) p.horizon = Math.max(1, Math.round((parseNumber(hz[1]) ?? 6) * (hz[2][0] === "y" ? 12 : hz[2][0] === "q" ? 3 : 1)));
  else if (/\bnext month\b/.test(t)) p.horizon = 1;
  else if (/\bnext year\b/.test(t)) p.horizon = 12;
  else if (/\bnext quarter\b/.test(t)) p.horizon = 3;

  // ---- intent
  const hasMetric = p.metrics.length > 0 || !!p.breakdown;
  const slotCount = [hasMetric, p.areas.length > 0 || p.nationalCue, !!p.time, !!(p.group || p.groupLevel), !!p.rank].filter(Boolean).length;
  p.slots = slotCount;

  const sawAlerts = RE.alerts.test(t);
  const sawSignals = RE.signals.test(t);
  const sawForecast = RE.forecast.test(t);
  const sawWeather = RE.weather.test(t);
  if (RE.map.test(t) && !sawAlerts && !sawForecast && !RE.explain.test(t)) p.intent = "map";
  else if (sawAlerts) p.intent = "alerts";
  else if (sawForecast) p.intent = "forecast";
  else if (sawSignals && !p.rank && !p.group && !p.groupLevel && p.metrics.every((k) => k === "cases" || k === "deaths")) p.intent = "signals";
  else if (sawWeather && RE.corr.test(t)) p.intent = "climate";
  else if (sawWeather && !hasMetric) p.intent = "weather";
  else if (RE.nsp.test(t) && !p.group && !p.groupLevel && !p.rank) p.intent = "nsp";
  else if (RE.population.test(t) && !hasMetric && !p.rank) p.intent = "population";
  else if (RE.explain.test(t)) p.intent = "explain";
  else if (RE.meta.test(t) && !p.areas.length) p.intent = "meta";
  else if (p.listLevel) p.intent = "list";
  else if (RE.brief.test(t) && !hasMetric && !p.group && !p.rank && !p.having.length) p.intent = "brief";
  else if (slotCount > 0) p.intent = "stats";
  else p.intent = "clarify";

  // a lone place name is best answered with a situation brief
  if (p.intent === "stats" && p.areas.length === 1 && !hasMetric && !p.time && !p.group && !p.groupLevel && !p.rank && !p.having.length && !p.compare) p.intent = "brief";

  // ---- follow-ups: a question that supplies at most one thing inherits the rest from the previous turn
  const cue = /^(?:and|also|what about|how about|now|then|same|but|only|just|instead|plus|ok|okay|so)\b|\b(?:it|that|those|there|them|same)\b/.test(t);
  const followUp = ctx && (slotCount <= 1 || (cue && slotCount <= 2)) && p.intent !== "list" && p.intent !== "meta";
  if (ctx && followUp) {
    const ownAreas = p.areas.length > 0;
    const ownMetrics = hasMetric;
    // after a forecast / weather / why-analysis, "and deaths?" or "what about Sylhet?" keeps that task
    const keepsTask = ["forecast", "weather", "climate", "explain", "signals", "map"].includes(ctx.intent);
    if (p.intent === "clarify") {
      if (keepsTask || ["stats", "brief"].includes(ctx.intent)) p.intent = ctx.intent as Intent;
      p.inherited.push("task");
    } else if (keepsTask && (p.intent === "stats" || p.intent === "brief") && !p.group && !p.groupLevel && !p.rank && !p.having.length && !p.breakdown && slotCount <= 1) {
      p.intent = ctx.intent as Intent;
      p.inherited.push("task");
    }
    if (p.intent === "forecast" && ownMetrics) p.forecastTarget = p.metrics.includes("deaths") ? "deaths" : "cases";
    if (p.intent === "brief" && !hasMetric && slotCount <= 1 && ctx.intent === "stats" && ownAreas) p.intent = "stats";
    if (!hasMetric && ctx.metrics.length && ["stats", "brief", "explain", "map"].includes(p.intent)) { p.metrics = [...ctx.metrics]; p.inherited.push("metric"); }
    if (!p.areas.length && !p.nationalCue && ctx.areas.length) {
      const sels = ctx.areas.map((r) => selFromRef(lk, r)).filter((s): s is AreaSel => !!s);
      if (sels.length) { p.areas = sels; p.inherited.push("area"); }
    }
    if (!p.time && ctx.time && !p.compare) {
      p.time = ctx.time.from >= 0
        ? makeTime(ctx.time.from, ctx.time.to, bounds.latestP, { months: ctx.time.months })
        : { from: -1, to: -1, months: ctx.time.months, label: ctx.time.label, explicit: true, years: [] };
      p.inherited.push("period");
    }
    if (!p.group && !p.groupLevel && ctx.group && ctx.group !== "none" && !p.rank && p.intent === "stats" && slotCount <= 1 && (TIME_GROUPS.includes(ctx.group as GroupKey) || !ownAreas)) {
      p.group = ctx.group as GroupKey;
      p.inherited.push("grouping");
    }
    // "show it on a map" after a ranking by district keeps the district level
    if (p.intent === "map" && !p.group && !p.groupLevel && !ownAreas && ["division", "district", "upazila"].includes(ctx.group ?? "")) {
      p.group = ctx.group as GroupKey;
      p.inherited.push("grouping");
    }
    if (p.intent === "stats" && p.inherited.length && p.slots === 0) p.slots = 1;
  }

  // a stats question with a lone place + inherited stuff stays stats; "brief" asked about an area with context metric → stats
  if (p.intent === "clarify" && p.areas.length) p.intent = "brief";
  return p;
}
