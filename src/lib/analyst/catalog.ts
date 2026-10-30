/**
 * What the analyst knows about the data: metrics (with fixed, whitelisted SQL), the words people use for them,
 * grouping dimensions, and a malaria glossary. Nothing user-supplied is ever concatenated into SQL — the
 * query builder only ever picks from the constants in this file.
 */

export type MetricUnit = "count" | "pct" | "rate";

export interface MetricDef {
  key: string;
  label: string;
  unit: MetricUnit;
  decimals: number;
  /** Row-level SQL (over alias m) for additive counts; the metric is sum(inner). */
  inner?: string;
  /** Full aggregate SQL. */
  expr: string;
  needsPop?: boolean;
  /** Ratio metrics: the minimum denominator before a rate is reliable enough to rank. */
  guard?: { expr: string; min: number; what: string };
  /** Not additive across areas (distinct counts) — no "share of total". */
  distinct?: boolean;
  /** Normalized words/phrases people use for this metric. */
  terms: string[];
  caveat?: string;
}

const count = (key: string, label: string, inner: string, terms: string[], caveat?: string): MetricDef => ({
  key, label, unit: "count", decimals: 0, inner, expr: `sum(${inner})::float8`, terms, caveat,
});

const ratio = (key: string, label: string, num: string, den: string, scale: number, terms: string[], decimals = 2, caveat?: string): MetricDef => ({
  key, label, unit: "pct", decimals, expr: `(${scale}.0 * sum(${num}) / nullif(sum(${den}), 0))::float8`, terms, caveat,
  guard: den === "m.tests" ? { expr: "sum(m.tests)", min: 100, what: "tests" } : { expr: "sum(m.cases)", min: 20, what: "cases" },
});

export const METRICS: MetricDef[] = [
  count("cases", "Confirmed cases", "m.cases", ["confirmed cases", "malaria cases", "positive cases", "cases", "case", "patients", "infections", "infection", "caseload", "case load", "burden"]),
  count("deaths", "Deaths", "m.deaths", ["deaths", "death", "died", "dead", "mortality", "fatalities", "fatal cases", "fatal"]),
  count("tests", "Persons tested", "m.tests", ["blood examination", "blood examinations", "blood slides", "tests", "test", "tested", "testing", "examined", "examinations", "screened", "screening", "rdts", "rdt", "slides"]),
  ratio("tpr", "Test positivity (%)", "m.cases", "m.tests", 100, ["test positivity rate", "test positivity", "positivity rate", "positive rate", "percent positive", "percentage positive", "slide positivity rate", "positivity", "tpr", "spr"]),
  ratio("cfr", "Case fatality (%)", "m.deaths", "m.cases", 100, ["case fatality rate", "case fatality", "case-fatality", "fatality rate", "death rate", "mortality rate", "lethality", "cfr"], 3),
  count("pf", "P. falciparum", "m.pf", ["plasmodium falciparum", "p. falciparum", "p falciparum", "falciparum", "pf cases", "pf"]),
  count("pv", "P. vivax", "m.pv", ["plasmodium vivax", "p. vivax", "p vivax", "vivax", "pv cases", "pv"]),
  count("mixed", "Mixed (Pf+Pv)", "m.mixed", ["mixed infections", "mixed infection", "mixed cases", "mixed"]),
  ratio("pf_share", "Falciparum share (%)", "m.pf + m.mixed", "m.cases", 100, ["falciparum share", "pf share", "falciparum percentage", "falciparum proportion", "falciparum ratio", "share of falciparum", "percentage of falciparum", "proportion of falciparum", "pf percentage", "pf proportion"], 1, "Falciparum share counts mixed (Pf+Pv) infections together with P. falciparum."),
  ratio("pv_share", "Vivax share (%)", "m.pv", "m.cases", 100, ["vivax share", "pv share", "vivax percentage", "vivax proportion", "share of vivax", "percentage of vivax", "proportion of vivax"], 1),
  ratio("female_share", "Female share (%)", "m.female", "m.male + m.female", 100, ["female share", "share of female", "percentage of female", "proportion of female", "female percentage", "share of women", "percentage of women", "proportion of women"], 1),
  ratio("male_share", "Male share (%)", "m.male", "m.male + m.female", 100, ["male share", "share of male", "percentage of male", "proportion of male", "male percentage", "share of men", "percentage of men", "proportion of men"], 1),
  ratio("under5_share", "Children under 5 share (%)", "m.age_lt1 + m.age_1_4", "m.cases", 100, ["share of children under 5", "percentage of children under 5", "under 5 share", "children under 5 share", "under five share"], 1),
  ratio("under15_share", "Children under 15 share (%)", "m.age_lt1 + m.age_1_4 + m.age_5_14", "m.cases", 100, ["children share", "share of children", "percentage of children", "proportion of children", "child share"], 1),
  ratio("adult_share", "Adults 15+ share (%)", "m.age_15_plus", "m.cases", 100, ["adult share", "share of adults", "percentage of adults", "proportion of adults"], 1),
  count("severe", "Severe cases", "m.severe", ["severe malaria", "severe cases", "severe"]),
  count("uncomplicated", "Uncomplicated cases", "m.uncomplicated", ["uncomplicated malaria", "uncomplicated cases", "uncomplicated"]),
  count("treated", "Treated", "m.treated", ["received treatment", "on treatment", "treated", "treatments", "treatment"]),
  count("referred", "Referred", "m.referred", ["referrals", "referral", "referred"], "Referral counts are rarely reported after 2014, so low or zero values reflect missing reporting."),
  ratio("treated_pct", "Treated share (%)", "m.treated", "m.cases", 100, ["treatment coverage", "treated percentage", "percent treated", "percentage treated", "treatment rate"], 1),
  ratio("severe_pct", "Severe share (%)", "m.severe", "m.cases", 100, ["severe share", "severe percentage", "percentage severe", "percent severe", "severity rate", "severity"], 1),
  count("male", "Male cases", "m.male", ["male cases", "males", "male", "men", "boys"]),
  count("female", "Female cases", "m.female", ["female cases", "females", "female", "women", "girls"]),
  count("pregnant", "Pregnant women", "m.pregnant", ["pregnant women", "pregnant", "pregnancy", "pregnancies", "expectant mothers"]),
  count("age_lt1", "Age under 1", "m.age_lt1", ["infants", "infant", "babies", "age under 1", "under 1 year", "under one year", "less than 1 year"]),
  count("age_1_4", "Age 1–4", "m.age_1_4", ["age 1-4", "aged 1-4", "1-4 years", "1 to 4 years", "toddlers", "1-4"]),
  count("age_5_14", "Age 5–14", "m.age_5_14", ["school age children", "school-age children", "school aged children", "age 5-14", "aged 5-14", "5-14 years", "5 to 14 years", "5-14"]),
  count("age_15_plus", "Age 15+", "m.age_15_plus", ["age 15 plus", "aged 15 plus", "15 plus", "15 and over", "15 and above", "over 15", "adults", "adult"]),
  count("under5", "Children under 5", "m.age_lt1 + m.age_1_4", ["children under 5", "children under five", "kids under 5", "under five", "under fives", "under-5", "u5", "under 5 years", "under five years", "age under 5"]),
  count("under15", "Children under 15", "m.age_lt1 + m.age_1_4 + m.age_5_14", ["children under 15", "under 15 years", "children", "child", "kids", "paediatric", "pediatric"]),
  count("acd", "Active case detection", "m.acd", ["active case detection", "active detection", "acd"], "Active/passive detection has only been recorded since 2021."),
  count("pcd", "Passive case detection", "m.pcd", ["passive case detection", "passive detection", "pcd"], "Active/passive detection has only been recorded since 2021."),
  count("llin", "LLINs distributed", "m.llin", ["long lasting insecticidal nets", "insecticide treated nets", "bed nets", "bednets", "bednet", "mosquito nets", "llins", "llin", "itns", "itn", "nets"], "LLIN reporting is erratic across years."),
  {
    key: "api", label: "API (per 1,000)", unit: "rate", decimals: 2, needsPop: true,
    expr: "(1000.0 * sum(m.cases) FILTER (WHERE p.upazila_id IS NOT NULL) / nullif(sum(p.population) / 12.0, 0))::float8",
    terms: ["annual parasite incidence", "parasite incidence", "incidence rate", "cases per 1000", "per 1000 population", "per thousand", "incidence", "api"],
    caveat: "API uses the population file, which covers the 77 at-risk upazilas of the 13 endemic districts only.",
  },
  {
    key: "aber", label: "ABER (%)", unit: "rate", decimals: 2, needsPop: true,
    expr: "(100.0 * sum(m.tests) FILTER (WHERE p.upazila_id IS NOT NULL) / nullif(sum(p.population) / 12.0, 0))::float8",
    terms: ["annual blood examination rate", "blood examination rate", "examination rate", "testing rate", "aber"],
    caveat: "ABER uses the population file, which covers the 77 at-risk upazilas of the 13 endemic districts only.",
  },
  { key: "upazilas_with_cases", label: "Upazilas with cases", unit: "count", decimals: 0, distinct: true, expr: "count(DISTINCT m.upazila_id) FILTER (WHERE m.cases > 0)::float8", terms: ["upazilas with cases", "affected upazilas", "active upazilas", "upazilas reporting cases"] },
  { key: "districts_with_cases", label: "Districts with cases", unit: "count", decimals: 0, distinct: true, expr: "count(DISTINCT m.district_name) FILTER (WHERE m.cases > 0)::float8", terms: ["districts with cases", "affected districts", "active districts", "districts reporting cases"] },
  { key: "reporting_units", label: "Reporting upazilas", unit: "count", decimals: 0, distinct: true, expr: "count(DISTINCT m.upazila_id)::float8", terms: ["reporting units", "reporting upazilas", "upazilas reporting", "upazilas that reported"] },
];

export const METRIC_BY_KEY = new Map(METRICS.map((m) => [m.key, m]));
export const metricOf = (key: string): MetricDef => {
  const m = METRIC_BY_KEY.get(key);
  if (!m) throw new Error(`Unknown metric ${key}`);
  return m;
};

/** "percentage of cases that are X" → the share metric for X. */
export const SHARE_OF: Record<string, string> = {
  pf: "pf_share", pv: "pv_share", severe: "severe_pct", treated: "treated_pct", male: "male_share", female: "female_share",
  under5: "under5_share", under15: "under15_share", age_15_plus: "adult_share",
};

/** Metrics shown when the user names none. */
export const DEFAULT_SUMMARY = ["cases", "deaths", "tests", "tpr"];
export const DEFAULT_RANK = ["cases", "deaths", "tests", "tpr"];

/** "by species / age / sex / detection" expand to several metrics. */
export const BREAKDOWNS = {
  species: { label: "species", metrics: ["pf", "pv", "mixed"], terms: ["species", "parasite type", "parasite types", "plasmodium"] },
  age: { label: "age group", metrics: ["age_lt1", "age_1_4", "age_5_14", "age_15_plus"], terms: ["age group", "age groups", "age band", "age bands", "age distribution", "age profile", "by age", "age-wise", "age wise", "ages"] },
  sex: { label: "sex", metrics: ["male", "female"], terms: ["sex", "gender", "male and female", "men and women", "males and females"] },
  detection: { label: "detection mode", metrics: ["acd", "pcd"], terms: ["detection mode", "detection type", "active and passive", "active vs passive"] },
} as const;
export type BreakdownKey = keyof typeof BREAKDOWNS;

export type GroupKey = "none" | "year" | "quarter" | "month" | "calmonth" | "division" | "district" | "upazila";
export const AREA_GROUPS: GroupKey[] = ["division", "district", "upazila"];
export const TIME_GROUPS: GroupKey[] = ["year", "quarter", "month", "calmonth"];

/* ------------------------------ Glossary ------------------------------ */

export interface GlossaryEntry {
  term: string;
  aliases: string[];
  text: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { term: "Test positivity rate (TPR)", aliases: ["tpr", "test positivity", "positivity", "positivity rate", "spr", "slide positivity rate"],
    text: "**TPR = confirmed cases ÷ persons tested × 100.** It shows how many of the people tested turned out to have malaria. A high TPR means transmission is intense or testing is too narrow (only the sickest are tested); a very low TPR with heavy testing suggests low transmission. WHO suggests TPR below 5% as a sign of good control." },
  { term: "Annual parasite incidence (API)", aliases: ["api", "annual parasite incidence", "parasite incidence", "incidence rate"],
    text: "**API = confirmed cases ÷ population at risk × 1,000 per year.** It is the standard malaria burden indicator and the basis of Bangladesh's risk classes and elimination targets. Here it is computed only where a population is known — the 77 at-risk upazilas of the 13 endemic districts (BBS Census 2022, projected yearly)." },
  { term: "Annual blood examination rate (ABER)", aliases: ["aber", "annual blood examination rate", "blood examination rate"],
    text: "**ABER = persons tested ÷ population × 100 per year.** It measures how hard surveillance is looking: low ABER can hide cases, so cases and TPR should always be read together with ABER." },
  { term: "Case fatality rate (CFR)", aliases: ["cfr", "case fatality", "case fatality rate", "fatality rate"],
    text: "**CFR = deaths ÷ confirmed cases × 100.** It reflects how severe the disease is among those diagnosed — driven by late care-seeking, P. falciparum share and access to treatment." },
  { term: "P. falciparum (Pf)", aliases: ["falciparum", "pf", "p falciparum", "plasmodium falciparum"],
    text: "**Plasmodium falciparum** causes most severe malaria and malaria deaths. Treated with artemisinin-based combination therapy (ACT) plus a single low dose of primaquine to block transmission. 'Pf share' here counts Pf plus mixed infections." },
  { term: "P. vivax (Pv)", aliases: ["vivax", "pv", "p vivax", "plasmodium vivax", "relapse", "radical cure"],
    text: "**Plasmodium vivax** forms dormant liver stages (hypnozoites) that cause relapses months later, so it needs *radical cure* (primaquine or tafenoquine after G6PD testing) in addition to treating the blood stage. Vivax tends to gain share as falciparum is controlled." },
  { term: "Active vs passive case detection (ACD / PCD)", aliases: ["acd", "pcd", "active case detection", "passive case detection", "active detection", "passive detection"],
    text: "**Passive case detection (PCD)** finds cases among people who come to a facility. **Active case detection (ACD)** means health workers go out and test people in the community, which is key near elimination. The MIS has recorded the split only since 2021." },
  { term: "Endemic channel", aliases: ["endemic channel", "endemic corridor"],
    text: "An **endemic channel** (WHO quartile method) shows the normal range of cases for each calendar month using several previous years. When the current month rises above the upper threshold it is an early signal of an outbreak. The Epidemiology tab draws it for any area." },
  { term: "Severe malaria", aliases: ["severe malaria", "complicated malaria"],
    text: "**Severe malaria** is malaria with signs of organ dysfunction (cerebral malaria, severe anaemia, respiratory distress…) and needs urgent injectable treatment (artesunate) in a hospital. The MIS records severe versus uncomplicated cases." },
  { term: "Mixed infection", aliases: ["mixed infection", "mixed infections", "mixed"],
    text: "A **mixed infection** is a case with both P. falciparum and P. vivax parasites. It is counted separately in the MIS and grouped with falciparum in the 'falciparum share'." },
  { term: "LLIN", aliases: ["llin", "llins", "itn", "itns", "bed net", "bed nets", "long lasting insecticidal net"],
    text: "**LLINs** (long-lasting insecticidal nets) are the main vector-control tool in Bangladesh's endemic districts. The MIS records nets distributed; the reporting is erratic across years." },
  { term: "Malaria elimination", aliases: ["elimination", "malaria elimination", "pre-elimination", "nsp"],
    text: "Bangladesh's National Malaria Elimination Programme (NMEP) aims to eliminate malaria nationally by 2030 and to be certified malaria-free thereafter. Progress is tracked with API, the number of active foci (upazilas with cases), and the National Strategic Plan (NSP) targets for cases, deaths and testing." },
  { term: "NMEP and the MIS", aliases: ["nmep", "mis", "management information system", "dhis2"],
    text: "The **NMEP** is Bangladesh's National Malaria Elimination Programme. The **MIS** is its monthly surveillance system: every health facility reports confirmed cases, tests, deaths, species, age, sex and treatment, summed per upazila per month. This dashboard syncs it daily." },
  { term: "Hotspot / foci", aliases: ["hotspot", "hotspots", "foci", "focus", "active foci"],
    text: "A **focus** (plural *foci*) is a place with ongoing local transmission. In this tool an upazila counts as an *active focus* when it reported at least one case in the last 12 months." },
  { term: "RDT", aliases: ["rdt", "rdts", "rapid diagnostic test"],
    text: "A **rapid diagnostic test (RDT)** detects malaria antigens from a finger-prick in ~15 minutes; with microscopy it is how cases are confirmed. Only *confirmed* cases are counted in the MIS." },
];

/* ------------------------------ Capabilities ------------------------------ */

export const STARTERS: { title: string; prompts: string[] }[] = [
  { title: "Situation", prompts: ["Give me a situation brief for Bangladesh", "How has malaria changed in the last 12 months?", "Brief on Bandarban district"] },
  { title: "Trends", prompts: ["Monthly cases and deaths in Cox's Bazar for 2025", "Yearly trend of falciparum vs vivax since 2018", "Which month of the year has the most cases?"] },
  { title: "Rankings", prompts: ["Top 10 upazilas by cases in the last 12 months", "Districts with more than 100 cases in 2025", "Which districts had deaths this year?"] },
  { title: "Compare", prompts: ["Compare Bandarban and Rangamati", "Which districts increased the most vs last year?", "Endemic districts cases 2025 vs 2024"] },
  { title: "Explain & predict", prompts: ["Why did cases change compared to last year?", "Forecast cases for Sylhet", "Does rainfall affect malaria in Rangamati?"] },
  { title: "Surveillance", prompts: ["Any unusual rise in cases this month?", "Recent death and surge alerts", "Test positivity by division in 2025"] },
];

export const CAPABILITIES = [
  "**Counts & rates** for any area and period — cases, deaths, tests, test positivity, case fatality, species, severe, treated, age, sex, pregnancy, active/passive detection, nets, API and ABER",
  "**Trends** by month, quarter, year or calendar month (seasonality), with peaks, lows and year-on-year change",
  "**Rankings & filters** — top/bottom N divisions, districts or upazilas, with conditions like “more than 100 cases” or “no deaths”",
  "**Comparisons** between places or periods, and “which areas increased the most”",
  "**Why-analysis** of a change: which areas, species and testing effort drove it",
  "**Unusual-rise detection** against each area's own history, plus stored death/surge alerts",
  "**Forecasts**, **ERA5 weather**, rainfall–malaria **correlations**, population, API/ABER and **NSP targets**",
  "**Definitions** of malaria terms (TPR, API, ABER, CFR, ACD/PCD…)",
];
