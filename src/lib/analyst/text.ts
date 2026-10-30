/** Small text utilities for the analyst's language understanding. */

export function normalize(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[–—−]/g, "-")
    .replace(/≥/g, " >= ")
    .replace(/≤/g, " <= ")
    .replace(/(\d)\s*\+/g, "$1 plus")
    .replace(/%/g, " percent ")
    .replace(/[^a-z0-9'<>=.,\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Replace matched spans with spaces so the same words are never read twice (positions are preserved). */
export function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

/** Bounded Levenshtein distance; returns max + 1 when the distance exceeds max. */
export function lev(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, "twenty four": 24, thirty: 30,
};
export const WORD_NUMBER_PATTERN = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty four|twenty|thirty";

/** "1,200" → 1200, "2.5k" → 2500, "twelve" → 12. */
export function parseNumber(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (WORD_NUMBERS[s] !== undefined) return WORD_NUMBERS[s];
  const m = /^(\d[\d,]*(?:\.\d+)?)\s*(k|m)?$/.exec(s);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  return m[2] === "k" ? base * 1000 : m[2] === "m" ? base * 1_000_000 : base;
}

const pluralize = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
export { pluralize };

export const fmtN = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "▲ 12.3%" / "▼ 4%" for a change expressed in percent. */
export function arrowPct(pct: number | null): string {
  if (pct === Infinity) return "new (none before)";
  if (pct === null || !Number.isFinite(pct)) return "n/a";
  if (Math.abs(pct) < 0.05) return "no change";
  return `${pct > 0 ? "▲" : "▼"} ${fmtN(Math.abs(pct), Math.abs(pct) < 10 ? 1 : 0)}%`;
}

export function pctChange(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  if (prev === 0) return cur === 0 ? 0 : cur > 0 ? Infinity : null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

export function joinList(items: string[], conj = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${conj} ${items[items.length - 1]}`;
}

/** Table cell for a % change: Infinity (rose from zero) is shown as "new". */
export const cellPct = (p: number | null): number | string | null => (p === Infinity ? "new" : p);
