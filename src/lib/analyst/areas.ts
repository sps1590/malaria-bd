/**
 * Resolving place names in free text to areas that exist in the MIS data — across spelling variants
 * (Chattogram/Chittagong…), multi-word names, several places in one question, named groups
 * ("endemic districts") and small typos.
 */
import { getAreaIndex, type AreaIndex } from "@/lib/agent-data";
import { ENDEMIC_DISTRICTS, canonicalGeoName, upazilaMatchKey } from "@/lib/malaria-metrics";
import { pretty } from "./format";
import { lev } from "./text";

export type AreaLevel = "division" | "district" | "upazila" | "group";

export interface AreaSel {
  /** Round-trippable reference, e.g. "district:Bandarban". */
  ref: string;
  label: string;
  level: AreaLevel;
  division?: string;
  /** District names as spelled in the data (a single district or the members of a group). */
  districts?: string[];
  upazilaIds?: number[];
}

type Upa = AreaIndex["upazilas"][number];

export interface AreaLookup {
  index: AreaIndex;
  divisions: Map<string, string>;
  districts: Map<string, { name: string; division: string }>;
  upazilas: Map<string, Upa[]>;
  /** Everything that can be fuzzy-matched: [key, kind]. */
  fuzzy: { key: string; kind: "division" | "district" | "upazila" }[];
  groups: Map<string, AreaSel>;
}

let cached: { index: AreaIndex; lookup: AreaLookup } | null = null;

export async function getLookup(): Promise<AreaLookup> {
  const index = await getAreaIndex();
  if (cached?.index === index) return cached.lookup;

  const divisions = new Map(index.divisions.map((d) => [canonicalGeoName(d), d]));
  const districts = new Map(index.districts.map((d) => [canonicalGeoName(d.name), d]));
  const upazilas = new Map<string, Upa[]>();
  for (const u of index.upazilas) {
    const k = canonicalGeoName(u.name);
    upazilas.set(k, [...(upazilas.get(k) ?? []), u]);
  }
  const members = (keys: readonly string[]) =>
    keys.map((k) => districts.get(canonicalGeoName(k))?.name).filter((n): n is string => !!n);
  const mk = (ref: string, label: string, names: readonly string[]): AreaSel => ({ ref, label, level: "group", districts: members(names) });
  const groups = new Map<string, AreaSel>([
    ["endemic", mk("group:endemic", "the 13 endemic districts", ENDEMIC_DISTRICTS)],
    ["cht", mk("group:cht", "the Chittagong Hill Tracts (Bandarban, Rangamati, Khagrachhari)", ["Bandarban", "Rangamati", "Khagrachhari"])],
  ]);
  const fuzzy: AreaLookup["fuzzy"] = [
    ...[...divisions.keys()].map((key) => ({ key, kind: "division" as const })),
    ...[...districts.keys()].map((key) => ({ key, kind: "district" as const })),
    ...[...upazilas.keys()].map((key) => ({ key, kind: "upazila" as const })),
  ];
  const lookup = { index, divisions, districts, upazilas, fuzzy, groups };
  cached = { index, lookup };
  return lookup;
}

const divisionSel = (lk: AreaLookup, name: string): AreaSel => ({ ref: `division:${name}`, label: `${pretty(name)} division`, level: "division", division: name });
const districtSel = (lk: AreaLookup, name: string): AreaSel => {
  const d = [...lk.districts.values()].find((x) => x.name === name);
  return { ref: `district:${name}`, label: `${pretty(name)} district`, level: "district", division: d?.division, districts: [name] };
};
const upazilaSel = (list: Upa[]): AreaSel => {
  const first = list[0];
  const districts = new Set(list.map((u) => u.district));
  return {
    ref: `upazila:${list.map((u) => u.id).join(",")}`,
    label: districts.size === 1 ? `${pretty(first.name)} upazila (${pretty(first.district)})` : `${pretty(first.name)} (${list.length} upazilas share this name)`,
    level: "upazila",
    division: first.division,
    districts: districts.size === 1 ? [first.district] : undefined,
    upazilaIds: list.map((u) => u.id),
  };
};

/** Rebuild an AreaSel from a context ref (so follow-up questions can reuse it). */
export function selFromRef(lk: AreaLookup, ref: string): AreaSel | null {
  const [kind, ...rest] = ref.split(":");
  const value = rest.join(":");
  if (kind === "group") return lk.groups.get(value) ?? null;
  if (kind === "division") return lk.index.divisions.includes(value) ? divisionSel(lk, value) : null;
  if (kind === "district") return lk.index.districts.some((d) => d.name === value) ? districtSel(lk, value) : null;
  if (kind === "upazila") {
    const ids = new Set(value.split(",").map(Number));
    const list = lk.index.upazilas.filter((u) => ids.has(u.id));
    return list.length ? upazilaSel(list) : null;
  }
  return null;
}

export type LevelHint = "division" | "district" | "upazila" | null;

export interface AreaFind {
  areas: AreaSel[];
  /** Human notes about guesses ("read 'Sylhet' as the division"). */
  notes: string[];
  /** Capitalised words that look like places but matched nothing. */
  unknown: string[];
  /** The text with named-group phrases ("endemic districts") consumed, so they are not read as grouping cues. */
  rest: string;
}

const GROUP_PATTERNS: { re: RegExp; key: string }[] = [
  { re: /\b(?:13 |thirteen )?(?:endemic|at[- ]risk|high[- ]burden|malaria[- ]endemic) (?:districts?|areas|zones)\b|\bendemic\b/, key: "endemic" },
  { re: /\b(?:chittagong|chattogram) hill tracts?\b|\bcht\b|\bhill (?:districts|tracts|areas)\b|\bhilly (?:districts|areas)\b/, key: "cht" },
];

/** Spellings the shared alias file does not cover. */
const EXTRA_ALIASES: Record<string, string> = { coxbazar: "coxsbazar", coxsbazaar: "coxsbazar", coxbazaar: "coxsbazar" };

const NOT_PLACES = new Set([
  "cases", "case", "deaths", "death", "tests", "tested", "total", "district", "division", "upazila", "month", "year",
  "bangladesh", "malaria", "which", "where", "what", "show", "give", "tell", "list", "from", "with", "that", "have", "this",
  "last", "since", "between", "number", "rate", "trend", "compare", "versus", "about", "there", "their", "would", "could",
  "upazilla", "thana", "zila", "zilla", "upazilas", "districts", "divisions", "thanas",
]);

const LEVEL_WORDS: Record<string, LevelHint> = {
  district: "district", districts: "district", zila: "district", zilla: "district",
  division: "division", divisions: "division",
  upazila: "upazila", upazilas: "upazila", upazilla: "upazila", upazillas: "upazila", thana: "upazila", thanas: "upazila",
};

export function findAreas(lk: AreaLookup, text: string, looseUpazila: boolean, originalCase: string, ignore: ReadonlySet<string>): AreaFind {
  const notes: string[] = [];
  const areas: AreaSel[] = [];
  let t = text;

  for (const g of GROUP_PATTERNS) {
    const m = g.re.exec(t);
    const sel = lk.groups.get(g.key);
    if (m && sel?.districts?.length) {
      areas.push(sel);
      t = t.slice(0, m.index) + " ".repeat(m[0].length) + t.slice(m.index + m[0].length);
    }
  }

  const words = [...t.matchAll(/[a-z]+(?:'[a-z]+)?/g)].map((m) => ({ w: m[0], at: m.index ?? 0 }));
  const used = new Array<boolean>(words.length).fill(false);
  const push = (sel: AreaSel) => {
    if (!areas.some((a) => a.ref === sel.ref)) areas.push(sel);
  };

  const lookupOrder = (key: string, hint: LevelHint): AreaSel | null => {
    const div = lk.divisions.get(key);
    const dist = lk.districts.get(key);
    const upa = lk.upazilas.get(key);
    const asDivision = () => (div ? divisionSel(lk, div) : null);
    const asDistrict = () => (dist ? districtSel(lk, dist.name) : null);
    const asUpazila = () => (upa ? upazilaSel(upa) : null);
    const order = hint === "district" ? [asDistrict, asDivision, asUpazila] : hint === "upazila" ? [asUpazila, asDistrict, asDivision] : [asDivision, asDistrict, asUpazila];
    const hit = order.map((f) => f()).find(Boolean) ?? null;
    if (hit && div && dist && !hint && hit.level === "division") {
      notes.push(`“${div}” is both a division and a district — I used the **${div} division**; say “${div} district” for the district alone.`);
    }
    return hit;
  };

  for (let size = 4; size >= 1; size--) {
    for (let i = 0; i + size <= words.length; i++) {
      if (used.slice(i, i + size).some(Boolean)) continue;
      const phrase = words.slice(i, i + size).map((x) => x.w).join(" ");
      const raw = canonicalGeoName(phrase);
      const key = EXTRA_ALIASES[raw] ?? raw;
      if (key.length < 4 || NOT_PLACES.has(key)) continue;
      // "Sylhet district" / "division of Chattogram": a level word next to the name decides which one is meant.
      const after = words[i + size]?.w;
      const before = words[i - 1]?.w === "of" ? words[i - 2]?.w : words[i - 1]?.w;
      const hint = (after && LEVEL_WORDS[after]) || (before && LEVEL_WORDS[before]) || null;
      const sel = lookupOrder(key, hint);
      if (sel) {
        push(sel);
        for (let k = i; k < i + size; k++) used[k] = true;
      }
    }
  }

  // Looser upazila spellings only when the question says "upazila"/"thana" (otherwise ordinary words sound-alike real names).
  if (looseUpazila) {
    const wanted = new Set(areas.flatMap((a) => (a.level === "upazila" ? a.upazilaIds ?? [] : [])));
    for (let i = 0; i < words.length; i++) {
      if (used[i] || words[i].w.length < 5 || ignore.has(words[i].w)) continue;
      const k = upazilaMatchKey(words[i].w);
      const list = lk.index.upazilas.filter((u) => upazilaMatchKey(u.name) === k && !wanted.has(u.id));
      if (list.length) {
        push(upazilaSel(list));
        used[i] = true;
      }
    }
  }

  // Typos: single unmatched words close to a real place name.
  for (let i = 0; i < words.length; i++) {
    const w = words[i].w;
    if (used[i] || w.length < 6 || ignore.has(w) || NOT_PLACES.has(w)) continue;
    const key = canonicalGeoName(w);
    const max = key.length >= 9 ? 2 : 1;
    let best: { key: string; kind: "division" | "district" | "upazila"; d: number } | null = null;
    let tie = false;
    for (const f of lk.fuzzy) {
      if (f.key[0] !== key[0]) continue;
      const d = lev(key, f.key, max);
      if (d > max) continue;
      if (!best || d < best.d) { best = { ...f, d }; tie = false; }
      else if (d === best.d && f.key !== best.key) tie = true;
    }
    if (best && !tie && best.d > 0) {
      const sel = lookupOrder(best.key, null);
      if (sel) {
        push(sel);
        used[i] = true;
        notes.push(`I read “${w}” as **${sel.label.replace(/ (division|district)$/, "")}**.`);
      }
    }
  }

  // Capitalised words in the original question that are still unexplained → probably a place we don't know.
  const unknown: string[] = [];
  const known = new Set(words.filter((_, i) => used[i]).map((x) => x.w));
  const original = [...originalCase.matchAll(/(?<![.?!]\s)(?<!^)\b[A-Z][a-z]{3,}(?:'s)?\b/g)].map((m) => m[0].toLowerCase().replace(/'s$/, ""));
  for (const w of original) {
    if (known.has(w) || ignore.has(w) || NOT_PLACES.has(w) || unknown.includes(w)) continue;
    if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(w)) continue;
    unknown.push(w);
  }
  return { areas, notes, unknown, rest: t };
}

/** The nearest real place names to a word, for "did you mean". */
export function suggestPlaces(lk: AreaLookup, word: string, n = 3): string[] {
  const key = canonicalGeoName(word);
  const scored = lk.fuzzy
    .filter((f) => f.kind !== "upazila" || key.length >= 5)
    .map((f) => ({ f, d: lev(key, f.key, 4) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d);
  const name = (f: { key: string; kind: string }) =>
    f.kind === "division" ? lk.divisions.get(f.key) : f.kind === "district" ? lk.districts.get(f.key)?.name : lk.upazilas.get(f.key)?.[0].name;
  return [...new Set(scored.map((x) => name(x.f)).filter((x): x is string => !!x))].slice(0, n);
}
