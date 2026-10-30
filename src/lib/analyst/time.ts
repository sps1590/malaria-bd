/**
 * Natural-language time parsing. Periods are month indexes P = year × 12 + (month − 1), so ranges, windows
 * and "same period last year" are plain integer arithmetic.
 */
import { MONTHS } from "@/lib/malaria-metrics";
import { WORD_NUMBER_PATTERN, blank, parseNumber } from "./text";

export const SHORT = MONTHS.map((m) => m.slice(0, 3));
export const pOf = (year: number, month: number) => year * 12 + month - 1;
export const yearOfP = (p: number) => Math.floor(p / 12);
export const monthOfP = (p: number) => (p % 12) + 1;
export const plabel = (p: number) => `${SHORT[monthOfP(p) - 1]} ${yearOfP(p)}`;

export interface TimeSel {
  from: number;
  to: number;
  months?: number[];
  /** Human label, e.g. "Oct 2025 – Sep 2026 (last 12 months)". */
  label: string;
  /** False when the analyst chose the window itself. */
  explicit: boolean;
  /** Years literally mentioned (for "2025 vs 2024" style questions). */
  years: number[];
  /** Short tag naming how it was phrased. */
  tag?: string;
}

const MON = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const monthNo = (token: string) => SHORT.findIndex((s) => s.toLowerCase() === token.slice(0, 3)) + 1;

const SEASONS: { re: RegExp; months: number[]; name: string }[] = [
  { re: /\bpre-?monsoon\b/, months: [3, 4, 5], name: "pre-monsoon (Mar–May)" },
  { re: /\bpost-?monsoon\b/, months: [10, 11], name: "post-monsoon (Oct–Nov)" },
  { re: /\b(?:monsoon|rainy season|wet season|rainy months)\b/, months: [6, 7, 8, 9, 10], name: "monsoon (Jun–Oct)" },
  { re: /\b(?:dry season|dry months)\b/, months: [11, 12, 1, 2, 3, 4], name: "dry season (Nov–Apr)" },
  { re: /\bwinter\b/, months: [12, 1, 2], name: "winter (Dec–Feb)" },
];

export function labelRange(from: number, to: number, latest: number): string {
  const base =
    from === to ? plabel(from)
    : monthOfP(from) === 1 && monthOfP(to) === 12 && yearOfP(from) === yearOfP(to) ? String(yearOfP(from))
    : monthOfP(from) === 1 && monthOfP(to) === 12 ? `${yearOfP(from)}–${yearOfP(to)}`
    : `${plabel(from)} – ${plabel(to)}`;
  const len = to - from + 1;
  if (to === latest && len === 12) return `${base} (last 12 months)`;
  if (to === latest && len > 1 && len < 12) return `${base} (last ${len} months)`;
  if (to === latest && monthOfP(from) === 1 && yearOfP(from) === yearOfP(to) && len < 12) return `${yearOfP(from)} to date (${plabel(from)} – ${plabel(to)})`;
  return base;
}

function monthListLabel(months: number[]): string {
  return months.map((m) => SHORT[m - 1]).join(", ");
}

export function makeTime(from: number, to: number, latest: number, opts: { months?: number[]; explicit?: boolean; years?: number[]; tag?: string } = {}): TimeSel {
  const months = opts.months?.length ? [...new Set(opts.months)] : undefined;
  let label = labelRange(from, to, latest);
  if (months) label = `${opts.tag ?? monthListLabel(months)} · ${label}`;
  return { from, to, months, label, explicit: opts.explicit ?? true, years: opts.years ?? [], tag: opts.tag };
}

export interface TimeParse {
  sel: TimeSel | null;
  /** Question text with the time phrases blanked out. */
  rest: string;
  notes: string[];
}

export function parseTime(text: string, latest: number, firstYear: number): TimeParse {
  let t = text;
  const notes: string[] = [];
  let range: [number, number] | null = null;
  let months: number[] | null = null;
  let tag: string | undefined;
  let seasonName: string | undefined;
  const years: number[] = [];
  const lastYear = yearOfP(latest);
  const floor = pOf(firstYear, 1);
  const clamp = (a: number, b: number): [number, number] => [Math.max(a, floor), Math.min(b, latest)];

  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(t);
    if (!m) return null;
    t = blank(t, m.index, m.index + m[0].length);
    return m;
  };

  // 1. "from Jan 2020 to Dec 2022", "2019-2021", "between 2018 and 2020"
  const MY = `(?:(${MON})\\s+)?(20\\d\\d)`;
  const r1 = take(new RegExp(`\\b(?:from|between|during|in)?\\s*${MY}\\s*(?:to|and|until|till|through|thru|-)\\s*${MY}\\b`));
  if (r1) {
    const y1 = Number(r1[2]), y2 = Number(r1[4]);
    years.push(y1, y2);
    const a = pOf(y1, r1[1] ? monthNo(r1[1]) : 1);
    const b = pOf(y2, r1[3] ? monthNo(r1[3]) : 12);
    range = clamp(Math.min(a, b), Math.max(a, b));
  }

  // 2. "last 6 months", "past 3 years", "previous two quarters"
  if (!range) {
    const r = take(new RegExp(`\\b(?:in |over |during |for |within )?(?:the )?(?:last|past|previous|prior|recent|latest)\\s+(\\d+|${WORD_NUMBER_PATTERN})\\s+(months?|years?|quarters?|weeks?)\\b`));
    if (r) {
      const n = parseNumber(r[1]) ?? 12;
      const unit = r[2][0];
      const len = unit === "y" ? n * 12 : unit === "q" ? n * 3 : unit === "w" ? Math.max(1, Math.ceil(n / 4.345)) : n;
      if (unit === "w") notes.push("The MIS is monthly, so weeks are rounded up to whole months.");
      range = clamp(latest - len + 1, latest);
      tag = `last ${len} months`;
    }
  }

  // 3. relative months / years
  if (!range) {
    if (take(/\b(?:this|current|latest|most recent|newest)\s+month\b/)) { range = [latest, latest]; tag = "latest month"; }
    else if (take(/\b(?:last|previous|prior)\s+month\b/)) { range = [latest - 1, latest - 1]; tag = "previous month"; }
    else if (take(/\b(?:last|previous|prior)\s+year\b/)) { range = clamp(pOf(lastYear - 1, 1), pOf(lastYear - 1, 12)); tag = "last calendar year"; }
    else if (take(/\bpast year\b|\blast twelve months\b|\bpast twelve months\b/)) { range = clamp(latest - 11, latest); tag = "last 12 months"; }
    else if (take(/\b(?:last|previous|prior|past)\s+quarter\b/)) { range = clamp(latest - 2, latest); tag = "last 3 months"; }
    else if (take(/\bthis quarter\b|\bcurrent quarter\b/)) { const qStart = pOf(lastYear, Math.floor((monthOfP(latest) - 1) / 3) * 3 + 1); range = clamp(qStart, latest); }
    else if (take(/\b(?:this|current)\s+year\b|\bytd\b|\byear[- ]to[- ]date\b/)) { range = clamp(pOf(lastYear, 1), latest); tag = "year to date"; }
  }

  // 4. "since 2020", "from March 2022", "2018 to date"
  if (!range) {
    const r = take(new RegExp(`\\b(?:since|from|after|starting(?: from)?|beginning)\\s+${MY}\\b`));
    if (r) {
      years.push(Number(r[2]));
      range = clamp(pOf(Number(r[2]), r[1] ? monthNo(r[1]) : 1), latest);
    } else {
      const r2 = take(new RegExp(`\\b${MY}\\s+(?:to date|till date|until now|to now|onwards?|to present|so far)\\b`));
      if (r2) {
        years.push(Number(r2[2]));
        range = clamp(pOf(Number(r2[2]), r2[1] ? monthNo(r2[1]) : 1), latest);
      }
    }
  }

  // 5. quarters: "Q1 2025", "first quarter of 2024"
  if (!range && !months) {
    const q = take(/\bq([1-4])\b(?:\s*(?:of\s+)?(20\d\d))?/);
    const qo = q ? null : take(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\b(?:\s*(?:of\s+)?(20\d\d))?/);
    const hit = q ?? qo;
    if (hit) {
      const idx = q ? Number(q[1]) : ({ first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4 } as Record<string, number>)[hit[1]];
      let y = hit[2] ? Number(hit[2]) : lastYear;
      if (!hit[2] && pOf(y, idx * 3 - 2) > latest) y -= 1;
      if (hit[2]) years.push(y);
      range = clamp(pOf(y, idx * 3 - 2), pOf(y, idx * 3));
      tag = `Q${idx}`;
    }
  }

  // 6. seasons
  for (const s of SEASONS) {
    if (take(s.re)) { months = s.months; seasonName = s.name; break; }
  }

  // 7. a single month with a year: "March 2025"
  if (!range) {
    const r = take(new RegExp(`\\b(?:in |during |for |of |on )?(${MON})\\s+(20\\d\\d)\\b`));
    if (r) {
      years.push(Number(r[2]));
      const p = pOf(Number(r[2]), monthNo(r[1]));
      range = [p, p];
    }
  }

  // 8. plain years: "2025", "2023 2025"
  if (!range) {
    const found = [...t.matchAll(/\b(20\d\d)\b/g)];
    if (found.length) {
      for (const f of found) t = blank(t, f.index ?? 0, (f.index ?? 0) + f[0].length);
      const ys = found.map((f) => Number(f[1]));
      years.push(...ys);
      const lo = Math.min(...ys), hi = Math.max(...ys);
      range = [Math.max(pOf(lo, 1), floor), Math.min(pOf(hi, 12), Math.max(latest, pOf(hi, 12)))];
      if (range[0] > latest) notes.push(`The data end at ${plabel(latest)}, so there are no reports for ${lo} yet.`);
      else range[1] = Math.min(range[1], latest);
    }
  }

  // 9. month names (need a preposition so "may" the verb is left alone): "in June", "during July and August", "Jun to Aug"
  if (!months) {
    const re = new RegExp(`\\b(?:in|during|for|of|every|each|across|between)\\s+((?:${MON})(?:\\s*(?:,|and|&|to|-|through)\\s*(?:${MON}))*)\\b`);
    const r = take(re);
    if (r) {
      const toks = r[1].match(new RegExp(`\\b(?:${MON})\\b`, "g")) ?? [];
      const nums = toks.map(monthNo);
      if (/\b(?:to|through|-)\b/.test(r[1]) && nums.length === 2) {
        const [a, b] = nums;
        months = [];
        for (let m = a; ; m = (m % 12) + 1) { months.push(m); if (m === b || months.length > 12) break; }
      } else months = nums;
    } else {
      // long-form month names are unambiguous even without a preposition
      const long = take(/\b(january|february|march|april|june|july|august|september|october|november|december)\b/);
      if (long) months = [monthNo(long[1])];
    }
  }

  // 10. all-time / vague
  if (!range) {
    if (take(/\b(?:all[- ]time|ever|entire history|full history|since inception|historical(?:ly)?|since the beginning|over the years|throughout the years|every year|whole period|all years)\b/)) {
      range = [floor, latest];
      tag = "all years";
    } else if (take(/\b(?:recent(?:ly)?|lately|these days|nowadays)\b/)) {
      range = clamp(latest - 5, latest);
      tag = "last 6 months";
      notes.push("“Recent” was read as the last 6 months.");
    } else if (take(/\b(?:now|currently|right now|at present|at the moment)\b/)) {
      range = clamp(latest - 2, latest);
      tag = "last 3 months";
      notes.push("“Now/currently” was read as the latest 3 months of data.");
    } else if (take(/\b(?:today|yesterday|this week|last week)\b/)) {
      range = [latest, latest];
      tag = "latest month";
      notes.push(`The MIS is reported monthly, so daily or weekly figures are not available; showing the latest month (${plabel(latest)}).`);
    }
  }

  if (!range && !months) return { sel: null, rest: t, notes };
  const [from, to] = range ?? [0, 0];
  if (!range) {
    // months only: the engine will pick the window; keep a marker with from/to unset
    return { sel: { from: -1, to: -1, months: months ?? undefined, label: seasonName ?? monthListLabel(months ?? []), explicit: true, years, tag: seasonName }, rest: t, notes };
  }
  return { sel: { ...makeTime(from, to, latest, { months: months ?? undefined, years, tag: seasonName }), tag }, rest: t, notes };
}
