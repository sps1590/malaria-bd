/**
 * Malaria MIS domain model, epidemiological formulas and Bangladesh geo helpers.
 * Isomorphic: used by the cron route (server) and both dashboards (client).
 */

import geoAliases from "./geo-aliases.json";

/* ------------------------------ Source model ------------------------------ */

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
export type MonthName = (typeof MONTHS)[number];

/** key = client field, source = MIS API field, column = Postgres column. Order defines RowTuple layout. */
export const NUMERIC_FIELDS = [
  { key: "pv", source: "PV", column: "pv", label: "P. vivax" },
  { key: "pf", source: "PF", column: "pf", label: "P. falciparum" },
  { key: "mixed", source: "MIXED", column: "mixed", label: "Mixed (Pf+Pv)" },
  { key: "tests", source: "TEST", column: "tests", label: "Tested" },
  { key: "cases", source: "CASEE", column: "cases", label: "Confirmed cases" },
  { key: "treated", source: "TREATED", column: "treated", label: "Treated" },
  { key: "referred", source: "REFERRED", column: "referred", label: "Referred" },
  { key: "deaths", source: "DEATH", column: "deaths", label: "Deaths" },
  { key: "uncomplicated", source: "UNCOMPLICATED", column: "uncomplicated", label: "Uncomplicated" },
  { key: "severe", source: "SEVERE", column: "severe", label: "Severe" },
  { key: "vivax", source: "VIVAX", column: "vivax", label: "Vivax (reported)" },
  { key: "llin", source: "LLIN", column: "llin", label: "LLIN" },
  { key: "llinc", source: "LLINC", column: "llinc", label: "LLIN (C)" },
  { key: "male", source: "MALE", column: "male", label: "Male" },
  { key: "female", source: "FEMALE", column: "female", label: "Female" },
  { key: "pregnant", source: "PREGNANT", column: "pregnant", label: "Pregnant women" },
  { key: "ageLt1", source: "1Y", column: "age_lt1", label: "Age <1" },
  { key: "age1to4", source: "14Y", column: "age_1_4", label: "Age 1–4" },
  { key: "age5to14", source: "514Y", column: "age_5_14", label: "Age 5–14" },
  { key: "age15plus", source: "15Y", column: "age_15_plus", label: "Age 15+" },
  { key: "acd", source: "ACD", column: "acd", label: "Active case detection" },
  { key: "pcd", source: "PCD", column: "pcd", label: "Passive case detection" },
] as const;

export type NumericField = (typeof NUMERIC_FIELDS)[number];
export type NumericKey = NumericField["key"];
export type NumericSource = NumericField["source"];
export const NUMERIC_KEYS: readonly NumericKey[] = NUMERIC_FIELDS.map((f) => f.key);

export type MisRecord = Record<NumericKey, number> & {
  upazilaId: number;
  upazilaName: string;
  districtId: number;
  districtName: string;
  divisionName: string;
  year: number;
  month: number; // 1–12
  population: number | null;
};

/* --------------------------- Compact transport --------------------------- */

export type AreaTuple = [
  upazilaId: number,
  upazilaName: string,
  districtId: number,
  districtName: string,
  divisionName: string,
];
/** counts follow NUMERIC_FIELDS order */
export type RowTuple = [
  upazilaId: number,
  year: number,
  month: number,
  population: number | null,
  ...counts: number[],
];

export interface MisDataset {
  areas: AreaTuple[];
  rows: RowTuple[];
  years: number[];
  syncedAt: string | null;
}

export function decodeDataset(ds: MisDataset): MisRecord[] {
  const areas = new Map(ds.areas.map((a) => [a[0], a] as const));
  const out: MisRecord[] = [];
  for (const row of ds.rows) {
    const area = areas.get(row[0]);
    if (!area) continue;
    const rec = {
      upazilaId: row[0],
      year: row[1],
      month: row[2],
      population: row[3],
      upazilaName: area[1],
      districtId: area[2],
      districtName: area[3],
      divisionName: area[4],
    } as MisRecord;
    NUMERIC_KEYS.forEach((k, i) => {
      rec[k] = row[4 + i] ?? 0;
    });
    out.push(rec);
  }
  return out;
}

/* ------------------------------ Aggregation ------------------------------ */

/**
 * Additive accumulator. Ratios are always derived from summed numerators and
 * denominators (never averaged). Population enters as person-years: each
 * upazila-month contributes population / 12, so API/ABER are valid for any
 * slice (single month, quarter, multi-year, any geography).
 */
export type Totals = Record<NumericKey, number> & {
  rows: number;
  personYears: number;
  casesWithPop: number; // numerator restricted to rows that have a denominator
  testsWithPop: number;
};

export function emptyTotals(): Totals {
  const t = { rows: 0, personYears: 0, casesWithPop: 0, testsWithPop: 0 } as Totals;
  for (const k of NUMERIC_KEYS) t[k] = 0;
  return t;
}

export function addRecord(t: Totals, r: MisRecord): Totals {
  for (const k of NUMERIC_KEYS) t[k] += r[k];
  t.rows += 1;
  if (r.population != null && r.population > 0) {
    t.personYears += personYears(r.population, 1);
    t.casesWithPop += r.cases;
    t.testsWithPop += r.tests;
  }
  return t;
}

export function addTotals(into: Totals, from: Totals): Totals {
  for (const k of NUMERIC_KEYS) into[k] += from[k];
  into.rows += from.rows;
  into.personYears += from.personYears;
  into.casesWithPop += from.casesWithPop;
  into.testsWithPop += from.testsWithPop;
  return into;
}

export function totalsOf(records: Iterable<MisRecord>): Totals {
  const t = emptyTotals();
  for (const r of records) addRecord(t, r);
  return t;
}

export function groupTotals<K>(records: Iterable<MisRecord>, keyOf: (r: MisRecord) => K): Map<K, Totals> {
  const groups = new Map<K, Totals>();
  for (const r of records) {
    const key = keyOf(r);
    let t = groups.get(key);
    if (!t) groups.set(key, (t = emptyTotals()));
    addRecord(t, r);
  }
  return groups;
}

/* ------------------------------- Formulas -------------------------------- */

export function personYears(population: number, monthsObserved = 12): number {
  return (population * monthsObserved) / 12;
}

/** API — Annual Parasite Incidence: confirmed cases per 1,000 population per year. */
export function annualParasiteIncidence(confirmedCases: number, populationYears: number): number | null {
  return populationYears > 0 ? (confirmedCases / populationYears) * 1000 : null;
}

/** TPR — Test Positivity Rate: % of persons tested (RDT/microscopy) who are positive. */
export function testPositivityRate(positives: number, tested: number): number | null {
  return tested > 0 ? (positives / tested) * 100 : null;
}

/** ABER — Annual Blood Examination Rate: persons tested per 100 population per year. */
export function annualBloodExaminationRate(tested: number, populationYears: number): number | null {
  return populationYears > 0 ? (tested / populationYears) * 100 : null;
}

export function caseFatalityRate(deaths: number, cases: number): number | null {
  return cases > 0 ? (deaths / cases) * 100 : null;
}

export function percentOf(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

export const INDICATORS = {
  api: { label: "API", unit: "per 1,000", formula: "Confirmed cases ÷ population-years × 1,000" },
  tpr: { label: "TPR", unit: "%", formula: "Confirmed cases ÷ persons tested × 100" },
  aber: { label: "ABER", unit: "%", formula: "Persons tested ÷ population-years × 100" },
  cfr: { label: "CFR", unit: "%", formula: "Deaths ÷ confirmed cases × 100" },
  pfShare: { label: "Pf+Mixed share", unit: "%", formula: "(P. falciparum + mixed) ÷ confirmed cases × 100" },
} as const;

export type IndicatorKey = keyof typeof INDICATORS;
export type MeasureKey = NumericKey | IndicatorKey;

export function isIndicator(key: string): key is IndicatorKey {
  return Object.hasOwn(INDICATORS, key);
}

export function measureValue(t: Totals, key: MeasureKey): number | null {
  switch (key) {
    case "api":
      return annualParasiteIncidence(t.casesWithPop, t.personYears);
    case "tpr":
      return testPositivityRate(t.cases, t.tests);
    case "aber":
      return annualBloodExaminationRate(t.testsWithPop, t.personYears);
    case "cfr":
      return caseFatalityRate(t.deaths, t.cases);
    case "pfShare":
      return percentOf(t.pf + t.mixed, t.cases);
    default:
      return t[key];
  }
}

const FIELD_LABELS = new Map<string, string>(NUMERIC_FIELDS.map((f) => [f.key, f.label]));

export function measureLabel(key: MeasureKey): string {
  if (isIndicator(key)) return `${INDICATORS[key].label} (${INDICATORS[key].unit})`;
  return FIELD_LABELS.get(key) ?? key;
}

const COUNT_FMT = new Intl.NumberFormat("en-US");
const RATE_FMT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatMeasure(key: MeasureKey, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return isIndicator(key) ? RATE_FMT.format(value) : COUNT_FMT.format(value);
}

/* --------------------------------- Geo ----------------------------------- */

/**
 * Spelling variants (MIS, BBS, HDX COD-AB, geoBoundaries) → one canonical key.
 * Shared with the Python pipeline (pipeline/common.py) so both sides join areas identically.
 */
const GEO_ALIASES: Record<string, string> = geoAliases.names;

export function canonicalGeoName(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\b(division|district|zila|zilla|upazila|upazilla|thana)\b/g, "")
    .replace(/[^a-z]/g, "");
  return GEO_ALIASES[base] ?? base;
}

/** MIS upazila spellings no phonetic rule reconciles (e.g. "Jessore Sadar" = Kotwali). */
const UPAZILA_ALIASES: Record<string, string> = geoAliases.upazila;

/**
 * Looser key for upazila names, whose transliterations vary widely
 * (Chilmary/Chilmari, Rowmari/Raumari, Sunamgonj-Sadar/Sunamganj Sadar).
 * Only compare within one district — the consonant skeleton is not globally unique.
 */
export function upazilaMatchKey(name: string): string {
  const letters = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(sadar|upazila|upazilla|thana)\b/g, " ")
    .replace(/\bsouth\b/g, "dakshin")
    .replace(/\bnorth\b/g, "uttar")
    .replace(/[^a-z]/g, "");
  if (!letters) return canonicalGeoName(name);
  const base = (UPAZILA_ALIASES[letters] ?? letters).replace(/ph/g, "f").replace(/z/g, "j");
  return (base[0] + base.slice(1).replace(/[aeiouhwy]/g, "")).replace(/(.)\1+/g, "$1");
}

export const DIVISION_DISTRICTS = {
  Barishal: ["Barguna", "Barishal", "Bhola", "Jhalokati", "Patuakhali", "Pirojpur"],
  Chattogram: ["Bandarban", "Brahmanbaria", "Chandpur", "Chattogram", "Cumilla", "Cox's Bazar", "Feni", "Khagrachhari", "Lakshmipur", "Noakhali", "Rangamati"],
  Dhaka: ["Dhaka", "Faridpur", "Gazipur", "Gopalganj", "Kishoreganj", "Madaripur", "Manikganj", "Munshiganj", "Narayanganj", "Narsingdi", "Rajbari", "Shariatpur", "Tangail"],
  Khulna: ["Bagerhat", "Chuadanga", "Jashore", "Jhenaidah", "Khulna", "Kushtia", "Magura", "Meherpur", "Narail", "Satkhira"],
  Mymensingh: ["Jamalpur", "Mymensingh", "Netrokona", "Sherpur"],
  Rajshahi: ["Bogura", "Chapainawabganj", "Joypurhat", "Naogaon", "Natore", "Pabna", "Rajshahi", "Sirajganj"],
  Rangpur: ["Dinajpur", "Gaibandha", "Kurigram", "Lalmonirhat", "Nilphamari", "Panchagarh", "Rangpur", "Thakurgaon"],
  Sylhet: ["Habiganj", "Moulvibazar", "Sunamganj", "Sylhet"],
} as const satisfies Record<string, readonly string[]>;

export type DivisionName = keyof typeof DIVISION_DISTRICTS;
export const UNASSIGNED_DIVISION = "Unassigned";

const DISTRICT_TO_DIVISION = new Map<string, DivisionName>(
  (Object.entries(DIVISION_DISTRICTS) as [DivisionName, readonly string[]][]).flatMap(([division, districts]) =>
    districts.map((d) => [canonicalGeoName(d), division] as const),
  ),
);

/** MIS has no division field; e.g. "Central Reporting" → "Unassigned". */
export function divisionOfDistrict(districtName: string): string {
  return DISTRICT_TO_DIVISION.get(canonicalGeoName(districtName)) ?? UNASSIGNED_DIVISION;
}
