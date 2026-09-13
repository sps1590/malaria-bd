#!/usr/bin/env python3
"""Import the NSP-BAN quantification workbook into the warehouse.

Every relevant sheet is stored, with the workbook file name, in `population_quantification`:
  census & projected population, FDMN population, NSP projected cases / API / deaths,
  ABER and testing targets, ITN and commodity requirements, foci population, case origin, unit costs.

It also derives the monthly-analysis denominators in `upazila_population` (years 2012-2035) so API and ABER
work everywhere in the dashboard:
  * Census 2022 population of each at-risk upazila is matched to its MIS reporting unit;
  * 2023+ follows the district mid-year projection in the workbook, earlier years use its growth rate;
  * facility reporting units in those districts (district hospital, CS office, medical college ...) get 0, so
    their cases count toward the district numerator without adding people.

Usage:  python pipeline/import_quantification.py "C:/path/NSP-BAN quantification_19042026_SV2 (1).xlsx"
"""
from __future__ import annotations

import argparse
import re
from collections import defaultdict
from pathlib import Path

import openpyxl

from common import canonical, connect, upazila_key

FIRST_YEAR, LAST_YEAR = 2012, 2035
AT_RISK_DISTRICTS = ["Bandarban", "Chattogram", "Cox's Bazar", "Habiganj", "Khagrachhari", "Kurigram", "Moulvibazar",
                     "Mymensingh", "Netrakona", "Rangamati", "Sherpur", "Sunamganj", "Sylhet"]
DISTRICT_KEYS = {canonical(d) for d in AT_RISK_DISTRICTS}
FACILITY = re.compile(r"hospital|college|office|\bsmo\b|others|nmcp|cmrl|bitid|beded|hdc|\bdist\b|distrct", re.I)
# Census upazilas that report under another MIS name / their parent upazila.
CENSUS_TO_MIS = {"shantiganj": "south sunamganj", "lakkhichhari": "laksmichari"}
NEW_UPAZILA_PARENT = {"eidgaon": "coxs bazar sadar", "guimara": "matiranga", "madhyanagar": "dharmapasha"}

DDL = [
    """CREATE TABLE IF NOT EXISTS population_quantification (
        id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        source_file   text NOT NULL,
        sheet         text NOT NULL,
        dataset       text NOT NULL,
        area_level    text NOT NULL,
        area_label    text NOT NULL,
        district_name text,
        upazila_name  text,
        mis_upazila_id integer,
        year          smallint,
        indicator     text NOT NULL,
        value         double precision,
        unit          text,
        note          text,
        imported_at   timestamptz NOT NULL DEFAULT now()
    )""",
    "CREATE INDEX IF NOT EXISTS population_quantification_lookup_idx ON population_quantification (dataset, area_level, area_label, year)",
    """CREATE TABLE IF NOT EXISTS upazila_population (
        upazila_id integer NOT NULL, year smallint NOT NULL, population integer NOT NULL, source text,
        PRIMARY KEY (upazila_id, year))""",
    "ALTER TABLE upazila_population DROP CONSTRAINT IF EXISTS upazila_population_population_check",
    "ALTER TABLE upazila_population ADD CONSTRAINT upazila_population_population_check CHECK (population >= 0)",
]


# ----------------------------------------------------------------------------- sheet helpers


def rows_of(ws) -> list[list]:
    return [list(r) for r in ws.iter_rows(values_only=True)]


def cell(row: list, j: int):
    return row[j] if j < len(row) else None


def num(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def text(v) -> str:
    return re.sub(r"\s+", " ", str(v)).strip() if v is not None else ""


def find_row(rows: list[list], pred, start: int = 0) -> int | None:
    for i in range(start, len(rows)):
        if pred(rows[i]):
            return i
    return None


def year_of(v) -> int | None:
    if isinstance(v, (int, float)) and not isinstance(v, bool) and float(v).is_integer() and 1990 <= v <= 2100:
        return int(v)
    m = re.search(r"(?:19|20)\d{2}", text(v))
    return int(m.group(0)) if m else None


def year_columns(header: list) -> list[tuple[int, int]]:
    return [(j, y) for j, v in enumerate(header) if j > 0 and (y := year_of(v))]


def level_of(label: str) -> str:
    if canonical(label) in DISTRICT_KEYS:
        return "district"
    low = label.lower()
    if "fdmn" in low:
        return "fdmn"
    if "64 districts" in low or low in {"total", "grand total"} or low.startswith("national"):
        return "national"
    return "region"


class Store:
    def __init__(self, source: str):
        self.source = source
        self.rows: list[tuple] = []

    def add(self, sheet, dataset, label, indicator, value, *, year=None, level=None, district=None, upazila=None,
            unit=None, note=None, mis_id=None):
        if value is None:
            return
        self.rows.append((self.source, sheet, dataset, level or level_of(label), label, district, upazila, mis_id,
                          year, indicator, value, unit, note))


# ----------------------------------------------------------------------------- parsers


def parse_census(wb, store: Store):
    sheet = "Population Census 2022"
    rows = rows_of(wb[sheet])
    h = find_row(rows, lambda r: text(cell(r, 0)) == "District" and text(cell(r, 1)).upper() == "UPAZILA")
    census = []
    for r in rows[h + 1:]:
        district, upazila, pop = text(cell(r, 0)), text(cell(r, 1)), num(cell(r, 2))
        if district and upazila and pop is not None:
            census.append({"district": district, "upazila": upazila, "population": int(pop), "note": text(cell(r, 5)) or None})
    national = {}
    for r in rows:
        for j, v in enumerate(r):
            label = text(v).rstrip(":")
            if label in {"Total country population", "Total population at risk", "Total population in non-endemic upazila",
                         "Male", "Female", "Others"} and num(cell(r, j + 1)) is not None:
                national[label] = num(cell(r, j + 1))
    for label, value in national.items():
        store.add(sheet, "national_population", "Bangladesh", label.lower().replace(" ", "_"), value, year=2022,
                  level="national", unit="people", note="BBS Population and Housing Census 2022")
    pivot = rows_of(wb["Pivot"])
    for r in pivot:
        for j, v in enumerate(r):
            if text(v).lower() == "non endemic upazila" and num(cell(r, j + 1)) is not None:
                store.add("Pivot", "national_population", "Bangladesh", "non_endemic_upazilas", num(cell(r, j + 1)),
                          level="national", unit="upazilas")
    return census, national


def parse_district_population(wb, store: Store):
    sheet = "District pop"
    rows = rows_of(wb[sheet])
    h = find_row(rows, lambda r: text(cell(r, 0)) == "Districts")
    header = rows[h]
    ycols = year_columns(header)
    growth_col = next(j for j, v in enumerate(header) if "growth" in text(v).lower())
    projections = {}
    for r in rows[h + 1:]:
        label = text(cell(r, 0))
        if not label or label.lower().startswith("gr of"):
            continue
        values = {y: num(cell(r, j)) for j, y in ycols if num(cell(r, j))}
        if not values:
            continue
        growth = num(cell(r, growth_col))
        dataset = "fdmn_population" if "fdmn" in label.lower() else "district_population"
        display = "13 at-risk districts" if label == "Total" else label
        for year, value in values.items():
            basis = "pre-census estimate" if year < 2022 else "Census 2022" if year == 2022 else "projected with divisional growth rate"
            store.add(sheet, dataset, display, "population", value, year=year, unit="people (July)", note=basis,
                      district=display if level_of(display) == "district" else None)
        if growth is not None and dataset == "district_population":
            store.add(sheet, dataset, display, "growth_rate", growth, unit="per year", note="Divisional growth rate")
        projections[display] = {"values": values, "growth": growth}
    return projections


def parse_projected_cases(wb, store: Store):
    sheet = "Projected_Cases"
    rows = rows_of(wb[sheet])
    h = find_row(rows, lambda r: text(cell(r, 1)) == "Year")
    ycols = year_columns(rows[h])
    for r in rows[h + 1:]:
        label = text(cell(r, 1))
        if label.startswith("Malaria cases by year") or label == "Total Case":
            area = "13 at-risk districts" if label == "Total Case" else label.rsplit("-", 1)[-1].strip()
            area = {"4 Districts (SYT)": "Sylhet Region", "4 Districts (MYN)": "Mymensingh Region"}.get(area, area)
            for j, y in ycols:
                v = num(cell(r, j))
                if v is not None and y >= 2022:
                    store.add(sheet, "nsp_projected_cases", area, "cases", v, year=y, unit="cases",
                              note="actual" if y <= 2025 else "NSP projection (intensified scenario)",
                              district=area if level_of(area) == "district" else None)
    h2 = find_row(rows, lambda r: text(cell(r, 1)) == "District(s)/Region")
    if h2 is not None:
        for r in rows[h2 + 1:]:
            label = text(cell(r, 1))
            if not label or label == "Grand Total":
                break
            store.add(sheet, "nsp_projected_cases", label, "required_annual_reduction", num(cell(r, 2)), unit="fraction",
                      note="Intensified scenario (avg 15-25% annual reduction, varies by district)",
                      district=label if level_of(label) == "district" else None)
    h3 = find_row(rows, lambda r: text(cell(r, 1)).startswith("Year") and "Y-" in text(cell(r, 2)).replace(" ", ""))
    if h3 is not None:
        ycols3 = year_columns(rows[h3])
        for r in rows[h3 + 1:]:
            label = text(cell(r, 1))
            if not label.startswith("API in"):
                continue
            area = label.replace("API in", "").strip()
            area = {"Sylhet Region (4 Districts)": "Sylhet Region", "Mymensingh Region (4 Districts)": "Mymensingh Region",
                    "3 CHT districts": "3 CHT districts", "10 districts": "10 non-CHT districts",
                    "13 districts": "13 at-risk districts"}.get(area, area)
            for j, y in ycols3:
                store.add(sheet, "nsp_api_target", area, "api", num(cell(r, j)), year=y, unit="per 1,000 population",
                          note="actual" if y <= 2025 else "NSP projection", district=area if level_of(area) == "district" else None)


def parse_projected_deaths(wb, store: Store):
    sheet = "Projected_Deaths"
    rows = rows_of(wb[sheet])
    h = find_row(rows, lambda r: text(cell(r, 1)) == "Year" and text(cell(r, 2)) == "National Cases")
    for r in rows[h + 1:]:
        year = year_of(cell(r, 1))
        if not year:
            break
        remark = text(cell(r, 5)) or None
        store.add(sheet, "nsp_projected_deaths", "13 at-risk districts", "cases", num(cell(r, 2)), year=year, unit="cases", note=remark)
        store.add(sheet, "nsp_projected_deaths", "13 at-risk districts", "cfr", num(cell(r, 3)), year=year, unit="fraction", note=remark)
        store.add(sheet, "nsp_projected_deaths", "13 at-risk districts", "deaths", num(cell(r, 4)), year=year, unit="deaths", note=remark)
    h2 = find_row(rows, lambda r: text(cell(r, 1)) == "Year")
    ycols = year_columns(rows[h2])
    for r in rows[h2 + 1:h]:
        label = text(cell(r, 1))
        if label.startswith("Mortality rate"):
            for j, y in ycols:
                store.add(sheet, "nsp_projected_deaths", "13 at-risk districts", "mortality_per_100k", num(cell(r, j)), year=y,
                          unit="deaths per 100,000", note="actual" if y <= 2025 else "NSP projection")


def parse_tests(wb, store: Store):
    sheet = "Test"
    rows = rows_of(wb[sheet])
    aber = find_row(rows, lambda r: text(cell(r, 0)) == "ABER")
    header = next(rows[i] for i in range(aber, -1, -1) if year_columns(rows[i]))
    ycols = year_columns(header)
    for r in rows[aber + 1:]:
        label = text(cell(r, 0))
        if not label:
            break
        area = "8 districts (Sylhet & Mymensingh regions)" if label.startswith("8 Districts") else label
        for j, y in ycols:
            store.add(sheet, "aber_target", area, "aber", num(cell(r, j)), year=y, unit="fraction of population tested per year",
                      note="NSP target", district=area if level_of(area) == "district" else None)
    for title, indicator in (("Test- District wise", "tests_total"), ("RDT-based Testing", "tests_rdt"), ("Microscopy-based Testing", "tests_microscopy")):
        start = find_row(rows, lambda r, t=title: text(cell(r, 0)) == t)
        if start is None:
            continue
        h = find_row(rows, lambda r: text(cell(r, 0)) == "District", start)
        ycols = year_columns(rows[h])
        for r in rows[h + 1:]:
            label = text(cell(r, 0))
            if not label:
                break
            for j, y in ycols:
                store.add(sheet, "test_target", label, indicator, num(cell(r, j)), year=y, unit="tests",
                          note="NSP quantification", district=label if level_of(label) == "district" else None)
    fdmn = find_row(rows, lambda r: text(cell(r, 0)) == "Test in FDMN")
    if fdmn is not None:
        ycols = year_columns(rows[fdmn + 1])
        for r in rows[fdmn + 2:fdmn + 6]:
            label = text(cell(r, 0))
            indicator = {"Population": "population", "Total test at FDMN": "tests_total", "Total tests by RDTs at FDMN": "tests_rdt",
                         "Total tests by Microscopy at FDMN": "tests_microscopy"}.get(label)
            if indicator:
                for j, y in ycols:
                    store.add(sheet, "test_target", "FDMN", indicator, num(cell(r, j)), year=y, level="fdmn")


def parse_simple_tables(wb, store: Store):
    # ITN summary
    rows = rows_of(wb["ITN Summary"])
    h = find_row(rows, lambda r: text(cell(r, 0)) == "Distribution Type")
    ycols = year_columns(rows[h])
    for r in rows[h + 1:]:
        label = text(cell(r, 1))
        if not label:
            break
        for j, y in ycols:
            store.add("ITN Summary", "itn_requirement", label, "itns", num(cell(r, j)), year=y, level="national" if "total" in label.lower() else "region",
                      unit="ITNs", note=text(cell(r, 0)) or None)
    # Commodity summary
    rows = rows_of(wb["All Summary"])
    h = find_row(rows, lambda r: text(cell(r, 0)) == "Particulars")
    ycols = year_columns(rows[h])
    for r in rows[h + 1:]:
        label = text(cell(r, 0))
        if not label or label.startswith("Item"):
            break
        for j, y in ycols:
            store.add("All Summary", "commodity_requirement", label, "quantity", num(cell(r, j)), year=y, level="national",
                      note=text(cell(r, 10)) or None)
    # Foci population and case origin
    rows = rows_of(wb["Foci Population"])
    h = find_row(rows, lambda r: text(cell(r, 0)) == "District" and text(cell(r, 2)).lower().startswith("avg"))
    for r in rows[h + 1:]:
        district, upazila = text(cell(r, 0)), text(cell(r, 1))
        if not district or district == "Grand Total":
            break
        label = f"{upazila.title()} ({district.title()})"
        for indicator, j, unit in (("avg_population_per_focus", 2, "people"), ("foci", 3, "foci"), ("foci_population", 4, "people")):
            store.add("Foci Population", "foci_population", label, indicator, num(cell(r, j)), year=2025, level="upazila",
                      district=district.title(), upazila=upazila.title(), unit=unit, note="Active foci 2025")
    h = find_row(rows, lambda r: text(cell(r, 1)) == "Indigenous")
    if h is not None:
        for r in rows[h + 1:]:
            label = text(cell(r, 0))
            if not label or label == "Percentage":
                break
            for indicator, j in (("indigenous", 1), ("imported", 2), ("imported_local", 3), ("total", 4)):
                store.add("Foci Population", "case_origin", "13 at-risk districts" if label == "Grand Total" else label, indicator,
                          num(cell(r, j)), year=2025, unit="cases", note="Case classification 2025")
    # Unit cost
    rows = rows_of(wb["Unit cost"])
    h = find_row(rows, lambda r: text(cell(r, 1)) == "SL No")
    for r in rows[h + 1:]:
        if num(cell(r, 1)) is None:
            break
        store.add("Unit cost", "unit_cost", text(cell(r, 2)), "unit_cost_usd", num(cell(r, 4)), level="national",
                  unit=f"USD per {text(cell(r, 3)).lower()}", note=text(cell(r, 5)) or "Wambo.org price")
    psm = find_row(rows, lambda r: "PSM" in text(cell(r, 1)) and "cost" in text(cell(r, 1)))
    if psm is not None:
        for r in rows[psm + 1:]:
            if num(cell(r, 1)) is None:
                break
            store.add("Unit cost", "unit_cost", text(cell(r, 2)), "psm_share_of_product_cost", num(cell(r, 3)), level="national", unit="fraction")
    # Sex split (CHT)
    rows = rows_of(wb["Anex "])
    h = find_row(rows, lambda r: text(cell(r, 0)) == "Districts" and text(cell(r, 1)) == "Total Population")
    for r in rows[h + 1:]:
        label = text(cell(r, 0))
        if not label:
            break
        for indicator, j in (("population", 1), ("male", 2), ("female", 3)):
            store.add("Anex", "population_sex", label, indicator, num(cell(r, j)), year=2022, unit="people", district=label,
                      note="Census 2022")


# ----------------------------------------------------------------------------- denominators


def build_denominators(con, census, projections, store: Store, sheet="Population Census 2022"):
    units = con.execute("""SELECT DISTINCT ON (upazila_id) upazila_id, district_name, upazila_name
                           FROM mis_monthly ORDER BY upazila_id, report_year DESC, report_month DESC""").fetchall()
    burden = dict(con.execute("""SELECT upazila_id, sum(cases) FROM mis_monthly
                                 WHERE report_year >= (SELECT max(report_year) - 4 FROM mis_monthly) GROUP BY 1""").fetchall())
    by_district = defaultdict(list)
    for uid, district, name in units:
        clean = re.sub(r"(?i)upazila health complex|health complex|\buhc\b", " ", name)
        by_district[canonical(district)].append({"id": uid, "name": name, "key": upazila_key(clean), "facility": bool(FACILITY.search(name)),
                                                 "cases": float(burden.get(uid) or 0)})

    base = defaultdict(int)          # upazila_id -> Census 2022 population
    labels = defaultdict(list)
    unmatched = []
    for c in census:
        dkey = canonical(c["district"])
        letters = re.sub(r"[^a-z]", "", c["upazila"].lower())
        candidates = [u for u in by_district[dkey] if not u["facility"]]
        wanted = upazila_key(CENSUS_TO_MIS.get(letters, c["upazila"]))
        match = sorted([u for u in candidates if u["key"] == wanted], key=lambda u: -u["cases"])
        via = ""
        if not match and letters in NEW_UPAZILA_PARENT:
            parent = upazila_key(NEW_UPAZILA_PARENT[letters])
            match = sorted([u for u in candidates if u["key"] == parent], key=lambda u: -u["cases"])
            via = f" (new upazila, reported under {NEW_UPAZILA_PARENT[letters].title()})"
        if match:
            base[match[0]["id"]] += c["population"]
            labels[match[0]["id"]].append(c["upazila"].title() + via)
        else:
            unmatched.append(f'{c["district"]}/{c["upazila"]}')
        store.add(sheet, "census_upazila_population", f'{c["upazila"].title()} ({c["district"]})', "population", c["population"],
                  year=2022, level="upazila", district=c["district"], upazila=c["upazila"].title(), unit="people",
                  mis_id=match[0]["id"] if match else None,
                  note="; ".join(filter(None, [c["note"], f"MIS unit: {match[0]['name']}{via}" if match else "no MIS reporting unit"])))

    # District projection ratios (2022 base) and growth for earlier years.
    ratio = {}
    for label, p in projections.items():
        if level_of(label) != "district" or 2022 not in p["values"]:
            continue
        growth = p["growth"] or 0.0
        series = {}
        for year in range(FIRST_YEAR, LAST_YEAR + 1):
            if year >= 2022 and year in p["values"]:
                series[year] = p["values"][year] / p["values"][2022]
            elif year < 2022:
                series[year] = 1 / (1 + growth) ** (2022 - year)
        ratio[canonical(label)] = series

    id_district = {u["id"]: dkey for dkey, lst in by_district.items() for u in lst}
    denominators = []
    for uid, pop in base.items():
        series = ratio.get(id_district[uid], {})
        for year in range(FIRST_YEAR, LAST_YEAR + 1):
            denominators.append((uid, year, round(pop * series.get(year, 1.0))))
    facilities = [u for dkey in DISTRICT_KEYS for u in by_district[dkey] if u["facility"]]
    for u in facilities:
        for year in range(FIRST_YEAR, LAST_YEAR + 1):
            denominators.append((u["id"], year, 0))
    uncovered = [f'{u["name"]} ({dkey}, {u["cases"]:.0f} cases/5y)' for dkey in DISTRICT_KEYS for u in by_district[dkey]
                 if not u["facility"] and u["id"] not in base and u["cases"] > 0]
    return denominators, unmatched, facilities, uncovered, labels


# ----------------------------------------------------------------------------- main


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workbook")
    args = parser.parse_args()
    path = Path(args.workbook)
    source = path.name
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    store = Store(source)

    census, national = parse_census(wb, store)
    projections = parse_district_population(wb, store)
    parse_projected_cases(wb, store)
    parse_projected_deaths(wb, store)
    parse_tests(wb, store)
    parse_simple_tables(wb, store)

    census_total = sum(c["population"] for c in census)
    stated = national.get("Total population at risk")
    print(f"Census 2022 at-risk upazilas: {len(census)}, population {census_total:,} (sheet states {stated:,.0f})")
    if stated and abs(census_total - stated) > 1:
        raise SystemExit("Census total does not match the stated population at risk — check the workbook.")

    with connect() as con:
        for statement in DDL:
            con.execute(statement)
        denominators, unmatched, facilities, uncovered, labels = build_denominators(con, census, projections, store)
        source_note = f"{source} · BBS Census 2022 upazila population, projected with the workbook's district growth"
        con.execute("DELETE FROM population_quantification WHERE source_file = %s", (source,))
        with con.cursor() as cur:
            cur.executemany(
                """INSERT INTO population_quantification (source_file, sheet, dataset, area_level, area_label, district_name,
                       upazila_name, mis_upazila_id, year, indicator, value, unit, note)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                store.rows,
            )
            cur.executemany(
                """INSERT INTO upazila_population (upazila_id, year, population, source) VALUES (%s, %s, %s, %s)
                   ON CONFLICT (upazila_id, year) DO UPDATE SET population = EXCLUDED.population, source = EXCLUDED.source""",
                [(uid, year, pop, source_note) for uid, year, pop in denominators],
            )

    datasets = defaultdict(int)
    for row in store.rows:
        datasets[row[2]] += 1
    print(f"Stored {len(store.rows)} rows in population_quantification from '{source}':")
    for name, count in sorted(datasets.items()):
        print(f"  {name:28} {count}")
    print(f"upazila_population: {len({d[0] for d in denominators})} MIS units x {LAST_YEAR - FIRST_YEAR + 1} years "
          f"({len(labels)} populated upazilas, {len(facilities)} facility units at 0)")
    print("Census upazilas without an MIS reporting unit:", ", ".join(unmatched) or "none")
    print("MIS units with cases in these districts but no census population:", "; ".join(uncovered) or "none")


if __name__ == "__main__":
    main()
