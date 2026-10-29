"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Range } from "xlsx";
import { CASE_BREAKS, ChoroplethMap, GEO_LEVELS, quantileBreaks, type AreaStat, type GeoLevel } from "@/components/BiTab";
import { BUILT_BY, captureNodePng, downloadDataUrl } from "@/components/ChartTools";
import { ADDITIVE_ONLY, PivotChart, type ChartKind, type ChartModel } from "@/components/PivotChart";
import {
  DIVISION_DISTRICTS,
  INDICATORS,
  canonicalGeoName,
  isEndemicDistrictKey,
  upazilaMatchKey,
  MONTHS,
  NUMERIC_FIELDS,
  addRecord,
  addTotals,
  decodeDataset,
  emptyTotals,
  formatMeasure,
  isIndicator,
  measureLabel,
  measureValue,
  type IndicatorKey,
  type MeasureKey,
  type MisDataset,
  type MisRecord,
  type Totals,
} from "@/lib/malaria-metrics";

/* -------------------------------- Config -------------------------------- */

type DimensionKey = "divisionName" | "districtName" | "upazilaName" | "year" | "quarter" | "yearMonth" | "month";
/** Any field — geography/time dimension or numeric measure — can now go in Rows, Columns or Values. */
type FieldKey = DimensionKey | MeasureKey;

interface FieldMeta {
  label: string;
  kind: "dimension" | "measure";
  title?: string;
  compare?: (a: string, b: string) => number;
  /** This field's value for one record — the grouping key when placed in Rows/Columns. */
  value: (r: MisRecord) => string;
}

const MONTH_ORDER = new Map<string, number>(MONTHS.map((m, i) => [m, i]));
const naturalCompare = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

const DIMENSIONS: Record<DimensionKey, { label: string; value: (r: MisRecord) => string; compare?: (a: string, b: string) => number }> = {
  divisionName: { label: "Division", value: (r) => r.divisionName },
  districtName: { label: "District", value: (r) => r.districtName },
  upazilaName: { label: "Upazila", value: (r) => r.upazilaName },
  year: { label: "Year", value: (r) => String(r.year) },
  quarter: { label: "Quarter", value: (r) => `${r.year}-Q${Math.ceil(r.month / 3)}` },
  yearMonth: { label: "Year-Month", value: (r) => `${r.year}-${String(r.month).padStart(2, "0")}` },
  month: {
    label: "Month (seasonal)",
    value: (r) => MONTHS[r.month - 1] ?? String(r.month),
    compare: (a, b) => (MONTH_ORDER.get(a) ?? 99) - (MONTH_ORDER.get(b) ?? 99),
  },
};

const DIMENSION_KEYS = Object.keys(DIMENSIONS) as DimensionKey[];
const INDICATOR_KEYS = Object.keys(INDICATORS) as IndicatorKey[];

/** A measure placed in Rows/Columns groups by that single record's own value for it (Excel does the same). */
function measureFieldValue(r: MisRecord, key: MeasureKey): string {
  if (!isIndicator(key)) return String(r[key]);
  const v = measureValue(addRecord(emptyTotals(), r), key);
  return v === null ? "—" : v.toFixed(2);
}

const FIELDS: Record<FieldKey, FieldMeta> = {
  ...Object.fromEntries(
    DIMENSION_KEYS.map((key) => [key, { label: DIMENSIONS[key].label, kind: "dimension" as const, compare: DIMENSIONS[key].compare, value: DIMENSIONS[key].value }]),
  ),
  ...Object.fromEntries(
    INDICATOR_KEYS.map((key) => [key, { label: INDICATORS[key].label, kind: "measure" as const, title: INDICATORS[key].formula, value: (r: MisRecord) => measureFieldValue(r, key) }]),
  ),
  ...Object.fromEntries(
    NUMERIC_FIELDS.map((f) => [f.key, { label: f.label, kind: "measure" as const, value: (r: MisRecord) => measureFieldValue(r, f.key) }]),
  ),
} as Record<FieldKey, FieldMeta>;

const ALL_FIELDS: { key: FieldKey; label: string; title?: string; tone: "dimension" | "count" | "indicator" }[] = [
  ...DIMENSION_KEYS.map((key) => ({ key: key as FieldKey, label: DIMENSIONS[key].label, tone: "dimension" as const })),
  ...INDICATOR_KEYS.map((key) => ({ key: key as FieldKey, label: INDICATORS[key].label, title: INDICATORS[key].formula, tone: "indicator" as const })),
  ...NUMERIC_FIELDS.map((f) => ({ key: f.key as FieldKey, label: f.label, tone: "count" as const })),
];

const toneOf = (key: FieldKey): "dimension" | "count" | "indicator" =>
  FIELDS[key].kind === "dimension" ? "dimension" : isIndicator(key) ? "indicator" : "count";

/** Header label for a value column: the measure's own label, or "Distinct <field>" for a dimension used as a value. */
const fieldValueLabel = (key: FieldKey) => (FIELDS[key].kind === "measure" ? measureLabel(key as MeasureKey) : `Distinct ${FIELDS[key].label}`);

function formatFieldValue(key: FieldKey, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return FIELDS[key].kind === "measure" ? formatMeasure(key as MeasureKey, v) : v.toLocaleString("en-US");
}

const MAX_FIELDS = 3; // per Rows and per Columns — nested left → right; Values is uncapped
const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 52;
const DIM_WIDTH = 190;
const VALUE_WIDTH = 124;
const KEY_SEP = "␟";

interface PivotConfig {
  rows: FieldKey[];
  columns: FieldKey[];
  values: FieldKey[];
  /** Optional report filters (like Excel's Filters area) — empty by default. */
  filters: FieldKey[];
}

const DEFAULT_CONFIG: PivotConfig = {
  rows: ["divisionName", "districtName"],
  columns: ["year"],
  values: ["cases", "tests", "tpr", "api"],
  filters: [],
};

/** Values each filter field is restricted to; a field with no entry (or not in config.filters) is unrestricted. */
type FilterSelection = Partial<Record<FieldKey, string[]>>;

type Zone = "rows" | "columns" | "values" | "filters";

/** How the result is shown (and what the downloads contain): the grid, a chart, or a map. */
type ViewKind = "table" | ChartKind | "map";
const VIEWS: { key: ViewKind; label: string }[] = [
  { key: "table", label: "Table" },
  { key: "column", label: "Column" },
  { key: "bar", label: "Bar" },
  { key: "stacked", label: "Stacked" },
  { key: "line", label: "Line" },
  { key: "area", label: "Area" },
  { key: "pie", label: "Pie" },
  { key: "map", label: "Map" },
];
const TOP_N_CHOICES = [10, 20, 50, 100, 0]; // 0 = all
const MAX_SERIES = 8; // the categorical palette has 8 hues — more series than that are cut, never recycled
const noopSelect = () => {};
const LEVEL_NAME: Record<GeoLevel, string> = { division: "Division", district: "District", upazila: "Upazila" };
const GEO_ROW_LEVELS: { field: FieldKey; level: GeoLevel }[] = [
  { field: "upazilaName", level: "upazila" },
  { field: "districtName", level: "district" },
  { field: "divisionName", level: "division" },
];
type SortState = { id: string; dir: 1 | -1 } | null;

/** Per-cell accumulator: summed Totals for measure values, plus a distinct-value Set per dimension field placed in Values. */
interface CellAgg {
  totals: Totals;
  distinct: Map<FieldKey, Set<string>>;
}
function newCellAgg(): CellAgg {
  return { totals: emptyTotals(), distinct: new Map() };
}
function addToCell(agg: CellAgg, record: MisRecord, distinctFields: FieldKey[]) {
  addRecord(agg.totals, record);
  for (const f of distinctFields) {
    let set = agg.distinct.get(f);
    if (!set) agg.distinct.set(f, (set = new Set()));
    set.add(FIELDS[f].value(record));
  }
}
function mergeCellInto(target: CellAgg, source: CellAgg) {
  addTotals(target.totals, source.totals);
  for (const [field, set] of source.distinct) {
    let t = target.distinct.get(field);
    if (!t) target.distinct.set(field, (t = new Set()));
    for (const v of set) t.add(v);
  }
}
function getOrCreateCell(map: Map<string, CellAgg>, key: string): CellAgg {
  let c = map.get(key);
  if (!c) map.set(key, (c = newCellAgg()));
  return c;
}

interface PivotRow {
  key: string;
  labels: string[];
  cells: Map<string, CellAgg>;
  total: CellAgg;
}
interface PivotColumn {
  key: string;
  labels: string[];
  label: string;
}
interface PivotResult {
  rows: PivotRow[];
  columns: PivotColumn[];
  columnTotals: Map<string, CellAgg>;
  grandTotal: CellAgg;
}
interface ValueColumn {
  id: string;
  colKey: string | null; // null → row total
  group: string;
  field: FieldKey;
}

/* ------------------------------ Pivot engine ----------------------------- */

function buildPivot(records: readonly MisRecord[], rowFields: FieldKey[], columnFields: FieldKey[], distinctFields: FieldKey[]): PivotResult {
  const rowMap = new Map<string, PivotRow>();
  const columnLabels = new Map<string, string[]>();
  const columnTotals = new Map<string, CellAgg>();
  const grandTotal = newCellAgg();

  for (const record of records) {
    const rowParts = rowFields.map((f) => FIELDS[f].value(record));
    const rowKey = rowParts.length ? rowParts.join(KEY_SEP) : "__all";
    let row = rowMap.get(rowKey);
    if (!row) {
      row = { key: rowKey, labels: rowParts, cells: new Map(), total: newCellAgg() };
      rowMap.set(rowKey, row);
    }
    addToCell(row.total, record, distinctFields);
    addToCell(grandTotal, record, distinctFields);

    if (columnFields.length) {
      const colParts = columnFields.map((f) => FIELDS[f].value(record));
      const colKey = colParts.join(KEY_SEP);
      if (!columnLabels.has(colKey)) columnLabels.set(colKey, colParts);
      addToCell(getOrCreateCell(row.cells, colKey), record, distinctFields);
      addToCell(getOrCreateCell(columnTotals, colKey), record, distinctFields);
    }
  }

  const rows = [...rowMap.values()].sort((a, b) => {
    for (let i = 0; i < rowFields.length; i++) {
      const c = (FIELDS[rowFields[i]].compare ?? naturalCompare)(a.labels[i], b.labels[i]);
      if (c) return c;
    }
    return 0;
  });
  const columns = [...columnLabels].map(([key, labels]) => ({ key, labels, label: labels.join(" · ") })).sort((a, b) => {
    for (let i = 0; i < columnFields.length; i++) {
      const c = (FIELDS[columnFields[i]].compare ?? naturalCompare)(a.labels[i], b.labels[i]);
      if (c) return c;
    }
    return 0;
  });

  return { rows, columns, columnTotals, grandTotal };
}

function buildValueColumns(columns: PivotColumn[], fields: FieldKey[], crossTab: boolean, showTotals: boolean): ValueColumn[] {
  // Without Columns every value column already is the row total, so there is no separate total to hide.
  if (!crossTab) return fields.map((f) => ({ id: f, colKey: null, group: "", field: f }));
  const body = columns.flatMap((c) => fields.map((f) => ({ id: `${c.key}${KEY_SEP}${f}`, colKey: c.key, group: c.label, field: f })));
  if (!showTotals) return body;
  return [...body, ...fields.map((f) => ({ id: `__total${KEY_SEP}${f}`, colKey: null, group: "Grand total", field: f }))];
}

function valueOf(row: PivotRow, vc: ValueColumn): number | null {
  const cell = vc.colKey === null ? row.total : row.cells.get(vc.colKey);
  if (!cell) return null;
  return FIELDS[vc.field].kind === "measure" ? measureValue(cell.totals, vc.field as MeasureKey) : (cell.distinct.get(vc.field)?.size ?? 0);
}

const TIME_DIMS = new Set<FieldKey>(["year", "quarter", "yearMonth", "month"]);

/**
 * Default order (no header sort chosen): time fields stay chronological; place/other fields go
 * from the most to the fewest cases (or deaths when deaths is the first value), group by group.
 */
function defaultOrder(rows: PivotRow[], fields: FieldKey[], firstMeasure: FieldKey | undefined): PivotRow[] {
  if (!fields.length || fields.every((d) => TIME_DIMS.has(d))) return rows;
  const basis = firstMeasure === "deaths" ? "deaths" : "cases";
  const groupTotal = new Map<string, number>();
  for (const row of rows) {
    for (let i = 0; i < fields.length; i++) {
      const key = row.labels.slice(0, i + 1).join(KEY_SEP);
      groupTotal.set(key, (groupTotal.get(key) ?? 0) + row.total.totals[basis]);
    }
  }
  return [...rows].sort((a, b) => {
    for (let i = 0; i < fields.length; i++) {
      if (TIME_DIMS.has(fields[i])) {
        const c = (FIELDS[fields[i]].compare ?? naturalCompare)(a.labels[i], b.labels[i]);
        if (c) return c;
        continue;
      }
      const ka = a.labels.slice(0, i + 1).join(KEY_SEP);
      const kb = b.labels.slice(0, i + 1).join(KEY_SEP);
      if (ka === kb) continue;
      return (groupTotal.get(kb) ?? 0) - (groupTotal.get(ka) ?? 0) || naturalCompare(a.labels[i], b.labels[i]);
    }
    return 0;
  });
}

function sortRows(rows: PivotRow[], sort: SortState, fields: FieldKey[], valueColumns: ValueColumn[], firstMeasure?: FieldKey): PivotRow[] {
  if (!sort) return defaultOrder(rows, fields, firstMeasure);
  const { id, dir } = sort;
  if (id.startsWith("dim:")) {
    const index = Number(id.slice(4));
    const field = fields[index];
    if (!field) return rows;
    const compare = FIELDS[field].compare ?? naturalCompare;
    return [...rows].sort((a, b) => dir * compare(a.labels[index], b.labels[index]));
  }
  const column = valueColumns.find((c) => c.id === id);
  if (!column) return rows;
  return rows
    .map((row) => ({ row, value: valueOf(row, column) }))
    .sort((a, b) => (a.value === null ? (b.value === null ? 0 : 1) : b.value === null ? -1 : dir * (a.value - b.value)))
    .map((x) => x.row);
}

/** Global exclusivity: a field picked for one zone is removed from wherever else it was, then appended to the target. */
function addField(cfg: PivotConfig, zone: Zone, key: FieldKey): PivotConfig {
  const rows = cfg.rows.filter((k) => k !== key);
  const columns = cfg.columns.filter((k) => k !== key);
  const values = cfg.values.filter((k) => k !== key);
  const filters = cfg.filters.filter((k) => k !== key);
  if (zone === "rows") return rows.length >= MAX_FIELDS ? cfg : { rows: [...rows, key], columns, values, filters };
  if (zone === "columns") return columns.length >= MAX_FIELDS ? cfg : { rows, columns: [...columns, key], values, filters };
  if (zone === "filters") return { rows, columns, values, filters: [...filters, key] };
  return { rows, columns, values: [...values, key], filters };
}

/* ------------------------------ UI pieces -------------------------------- */

/** Small removable tag for a field already placed in Rows/Columns/Values. */
function FieldTag({ label, tone, onRemove }: { label: string; tone: "dimension" | "count" | "indicator"; onRemove: () => void }) {
  const tones = {
    dimension: "border-sky-200 bg-sky-50 text-sky-800",
    count: "border-slate-200 bg-white text-slate-700",
    indicator: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-medium ${tones[tone]}`}>
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="ml-0.5 text-slate-400 hover:text-red-600">
        ×
      </button>
    </span>
  );
}

/**
 * One control in the field bar: shows the fields already assigned as removable tags plus a
 * "+" button. Clicking "+" pops a list of the fields NOT yet used anywhere else — every field is
 * available to every zone, and a field picked for one zone disappears from the other pickers.
 */
function FieldPickerGroup({
  label,
  hint,
  tags,
  customTags,
  options,
  onAdd,
  disabled,
}: {
  label: string;
  hint: string;
  tags?: { key: string; label: string; tone: "dimension" | "count" | "indicator"; onRemove: () => void }[];
  /** Replaces the plain tags (the Filters zone renders tags that open a value checklist). */
  customTags?: ReactNode;
  options: { key: string; label: string; title?: string; tone: "dimension" | "count" | "indicator" }[];
  onAdd: (key: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      {customTags ?? tags?.map((t) => <FieldTag key={t.key} label={t.label} tone={t.tone} onRemove={t.onRemove} />)}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={hint}
        aria-expanded={open}
        className="rounded border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-500 hover:border-indigo-400 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        + Add
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg">
          {options.length === 0 ? (
            <p className="p-2 text-xs text-slate-400">No more fields available.</p>
          ) : (
            options.map((o) => (
              <button
                key={o.key}
                type="button"
                title={o.title}
                onClick={() => {
                  onAdd(o.key);
                  setOpen(false);
                }}
                className={`block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50 ${o.tone === "indicator" ? "text-emerald-800" : o.tone === "dimension" ? "text-sky-800" : "text-slate-700"}`}
              >
                {o.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A field placed in Filters: click its name to pop a checklist of that field's values (like Excel's
 * report filter). No checks changed = all values pass; the badge shows "n of m" once restricted.
 */
function FilterTag({
  label,
  tone,
  allValues,
  selected,
  onChange,
  onRemove,
}: {
  label: string;
  tone: "dimension" | "count" | "indicator";
  allValues: string[];
  selected: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  const chosen = useMemo(() => new Set(selected ?? allValues), [selected, allValues]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? allValues.filter((v) => v.toLowerCase().includes(q)) : allValues;
  }, [allValues, search]);
  const restricted = selected !== undefined && selected.length !== allValues.length;
  const commit = (next: Set<string>) => onChange(next.size === allValues.length ? undefined : allValues.filter((v) => next.has(v)));
  const toggle = (v: string) => {
    const next = new Set(chosen);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    commit(next);
  };

  return (
    <span ref={ref} className="relative inline-flex">
      <span className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-medium ${restricted ? "border-amber-300 bg-amber-50 text-amber-900" : tone === "dimension" ? "border-sky-200 bg-sky-50 text-sky-800" : "border-slate-200 bg-white text-slate-700"}`}>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Choose which values to include" className="inline-flex items-center gap-1">
          {label}
          <span className="text-[10px] font-normal opacity-70">{restricted ? `${chosen.size} of ${allValues.length}` : "All"} ▾</span>
        </button>
        <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="ml-0.5 text-slate-400 hover:text-red-600">
          ×
        </button>
      </span>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-60 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${label.toLowerCase()}…`}
            className="mb-1.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            aria-label={`Search ${label} values`}
          />
          <div className="mb-1 flex gap-3 text-[11px] text-indigo-700">
            <button type="button" onClick={() => onChange(undefined)} className="hover:underline">Select all</button>
            <button type="button" onClick={() => onChange([])} className="hover:underline">Clear</button>
          </div>
          <div className="max-h-56 overflow-y-auto">
            {shown.length === 0 ? (
              <p className="p-2 text-xs text-slate-400">No matching values.</p>
            ) : (
              shown.map((v) => (
                <label key={v} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-slate-700 hover:bg-slate-50">
                  <input type="checkbox" checked={chosen.has(v)} onChange={() => toggle(v)} />
                  <span className="truncate" title={v}>{v}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </span>
  );
}

const ENDEMIC_TOKEN = "__endemic";

/**
 * Multi-select district dropdown for the toolbar: "All districts" (the default, nothing ticked),
 * "Endemic Districts" (the 13 at-risk districts as one tick) and then each district by name.
 * Picks combine — Endemic Districts plus a district outside that list shows both.
 */
function DistrictPicker({
  options,
  picked,
  onChange,
}: {
  options: { key: string; label: string }[];
  picked: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  const chosen = new Set(picked);
  const names = new Map(options.map((o) => [o.key, o.label]));
  const parts = picked.map((p) => (p === ENDEMIC_TOKEN ? "Endemic Districts" : (names.get(p) ?? p)));
  const summary = parts.length === 0 ? "All districts" : parts.length <= 2 ? parts.join(" + ") : `${parts[0]} + ${parts.length - 1} more`;
  const q = search.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const toggle = (token: string) => onChange(chosen.has(token) ? picked.filter((p) => p !== token) : [...picked, token]);
  const row = "flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-slate-50";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="District filter"
        className={`flex max-w-56 items-center gap-1.5 rounded border px-2 py-1.5 ${picked.length ? "border-amber-300 bg-amber-50 text-amber-900" : "border-slate-300 bg-white"}`}
      >
        <span className="truncate">{summary}</span>
        <span className="text-[10px] opacity-60">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 max-w-[85vw] rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search districts…"
            className="mb-1.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            aria-label="Search districts"
          />
          <div className="max-h-64 overflow-y-auto">
            <label className={`${row} font-medium text-slate-800`}>
              <input type="checkbox" checked={picked.length === 0} onChange={() => onChange([])} />
              All districts
            </label>
            <label className={`${row} font-medium text-amber-800`} title="Bandarban, Rangamati, Khagrachhari, Cox's Bazar, Chattogram, Sylhet, Sunamganj, Habiganj, Moulvibazar, Mymensingh, Sherpur, Netrokona, Kurigram">
              <input type="checkbox" checked={chosen.has(ENDEMIC_TOKEN)} onChange={() => toggle(ENDEMIC_TOKEN)} />
              Endemic Districts <span className="font-normal opacity-70">(13)</span>
            </label>
            <div className="my-1 border-t border-slate-100" />
            {shown.length === 0 ? (
              <p className="p-2 text-xs text-slate-400">No matching districts.</p>
            ) : (
              shown.map((o) => (
                <label key={o.key} className={`${row} text-slate-700`}>
                  <input type="checkbox" checked={chosen.has(o.key)} onChange={() => toggle(o.key)} />
                  <span className="truncate">{o.label}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const fileStem = () => `malaria-pivot-${new Date().toISOString().slice(0, 10)}`;
const periodString = (t: number) => `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
const periodIndex = (s: string) => {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
};

/* ------------------------------- Component ------------------------------- */

export default function PivotTab({ dataset }: { dataset: MisDataset }) {
  const records = useMemo(() => decodeDataset(dataset), [dataset]);
  const divisions = useMemo(() => [...new Set(records.map((r) => r.divisionName))].sort(naturalCompare), [records]);
  const periodBounds = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of records) {
      const t = r.year * 12 + r.month - 1;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    return lo === Infinity ? { min: "", max: "" } : { min: periodString(lo), max: periodString(hi) };
  }, [records]);
  const [monthFrom, setMonthFrom] = useState(periodBounds.min);
  const [monthTo, setMonthTo] = useState(periodBounds.max);

  const [config, setConfig] = useState<PivotConfig>(DEFAULT_CONFIG);
  const [division, setDivision] = useState("");
  // District picks: ENDEMIC_TOKEN and/or district keys; empty = every district (the default).
  const [districtPick, setDistrictPick] = useState<string[]>([]);
  const [casesOnly, setCasesOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [exporting, setExporting] = useState<"xlsx" | "pdf" | "png" | null>(null);
  const [filterSel, setFilterSel] = useState<FilterSelection>({});
  const [hideTotals, setHideTotals] = useState(false);
  const [view, setView] = useState<ViewKind>("table");
  const [plotField, setPlotField] = useState<FieldKey | null>(null);
  const [topN, setTopN] = useState(20);
  const [mapLevelSel, setMapLevelSel] = useState<GeoLevel | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  // Every distinct value of each field placed in Filters (from all loaded records, so the checklist
  // doesn't shrink as other filters narrow the data), in the field's natural order.
  const filterValues = useMemo(() => {
    const out = new Map<FieldKey, string[]>();
    for (const f of config.filters) {
      const set = new Set<string>();
      for (const r of records) set.add(FIELDS[f].value(r));
      out.set(f, [...set].sort(FIELDS[f].compare ?? naturalCompare));
    }
    return out;
  }, [records, config.filters]);

  // District choices (narrowed to the chosen division), keyed the same way the map/geo code keys them.
  const districtKeyOf = useMemo(() => new Map([...new Set(records.map((r) => r.districtName))].map((n) => [n, canonicalGeoName(n)])), [records]);
  const districtOptions = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const r of records) {
      if (division && r.divisionName !== division) continue;
      byKey.set(districtKeyOf.get(r.districtName) ?? r.districtName, r.districtName);
    }
    // All 64 districts are offered, including ones that have reported nothing in the data.
    for (const [div, names] of Object.entries(DIVISION_DISTRICTS)) {
      if (division && div !== division) continue;
      for (const name of names) if (!byKey.has(canonicalGeoName(name))) byKey.set(canonicalGeoName(name), name);
    }
    return [...byKey].map(([key, label]) => ({ key, label })).sort((a, b) => naturalCompare(a.label, b.label));
  }, [records, division, districtKeyOf]);

  const filtered = useMemo(() => {
    const a = periodIndex(monthFrom) ?? -Infinity;
    const b = periodIndex(monthTo) ?? Infinity;
    const [from, to] = a <= b ? [a, b] : [b, a];
    const active = config.filters
      .map((f) => ({ f, allowed: filterSel[f] }))
      .filter((x): x is { f: FieldKey; allowed: string[] } => x.allowed !== undefined)
      .map((x) => ({ f: x.f, allowed: new Set(x.allowed) }));
    const pickedKeys = new Set(districtPick.filter((p) => p !== ENDEMIC_TOKEN));
    const withEndemic = districtPick.includes(ENDEMIC_TOKEN);
    const districtOk = (name: string) => {
      if (!districtPick.length) return true;
      const key = districtKeyOf.get(name) ?? name;
      return pickedKeys.has(key) || (withEndemic && isEndemicDistrictKey(key));
    };
    return records.filter((r) => {
      const t = r.year * 12 + r.month - 1;
      if (t < from || t > to || (division && r.divisionName !== division) || !districtOk(r.districtName)) return false;
      return active.every((x) => x.allowed.has(FIELDS[x.f].value(r)));
    });
  }, [records, division, districtPick, districtKeyOf, monthFrom, monthTo, config.filters, filterSel]);
  // Dimension fields placed in Values are aggregated as a distinct count, so the pivot engine
  // needs to know which fields to track Sets for.
  const distinctValueFields = useMemo(() => config.values.filter((f) => FIELDS[f].kind === "dimension"), [config.values]);
  const pivot = useMemo(
    () => buildPivot(filtered, config.rows, config.columns, distinctValueFields),
    [filtered, config.rows, config.columns, distinctValueFields],
  );
  const valueColumns = useMemo(
    () => buildValueColumns(pivot.columns, config.values, config.columns.length > 0, !hideTotals),
    [pivot.columns, config.values, config.columns, hideTotals],
  );
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    // "Cases ≥ 1" hides result rows with no confirmed cases (e.g. districts/upazilas that reported none).
    if (!q && !casesOnly) return pivot.rows;
    return pivot.rows.filter((r) => (!casesOnly || r.total.totals.cases >= 1) && (!q || r.labels.some((l) => l.toLowerCase().includes(q))));
  }, [pivot.rows, query, casesOnly]);
  // Grand total reflects the row filter, like an Excel pivot.
  const totalRow = useMemo<PivotRow>(() => {
    if (visibleRows === pivot.rows) {
      return { key: "__grand", labels: [], cells: pivot.columnTotals, total: pivot.grandTotal };
    }
    const cells = new Map<string, CellAgg>();
    const total = newCellAgg();
    for (const row of visibleRows) {
      mergeCellInto(total, row.total);
      for (const [key, cell] of row.cells) mergeCellInto(getOrCreateCell(cells, key), cell);
    }
    return { key: "__grand", labels: [], cells, total };
  }, [pivot, visibleRows]);
  const rows = useMemo(
    () => sortRows(visibleRows, sort, config.rows, valueColumns, config.values[0]),
    [visibleRows, sort, config.rows, valueColumns, config.values],
  );

  /* ----------------------- Chart / map view of the same result ----------------------- */

  // A chart has one value axis, so one measure is plotted at a time (mixing counts with rates on one
  // axis would mislead); the picker chooses among the measures placed in Values.
  const measureFields = useMemo(() => config.values.filter((f) => FIELDS[f].kind === "measure"), [config.values]);
  const chartField = plotField && measureFields.includes(plotField) ? plotField : (measureFields[0] ?? null);
  const additive = chartField !== null && !isIndicator(chartField);
  const isChartView = view !== "table" && view !== "map";
  const chartUnsuitable = isChartView && ADDITIVE_ONLY.includes(view) && !additive;

  const chart = useMemo<{ model: ChartModel; note: string; title: string } | null>(() => {
    if (!isChartView || !chartField || chartUnsuitable) return null;
    const timeOnly = (fs: FieldKey[]) => fs.length > 0 && fs.every((f) => TIME_DIMS.has(f));
    const labelOf = (r: PivotRow) => (config.rows.length ? r.labels.join(" · ") : "All records");
    const crossTab = config.columns.length > 0;
    const notes: string[] = [];
    const round = (v: number | null) => (v === null ? null : isIndicator(chartField) ? Math.round(v * 100) / 100 : v);
    const cell = (row: PivotRow, colKey: string | null) => round(valueOf(row, { id: "", colKey, group: "", field: chartField }));

    let cats = rows;
    if (topN > 0 && cats.length > topN) {
      cats = timeOnly(config.rows) ? cats.slice(-topN) : cats.slice(0, topN);
      notes.push(`Showing ${timeOnly(config.rows) ? "the latest" : "the first"} ${topN} of ${rows.length.toLocaleString("en-US")} rows`);
    }

    let cols = pivot.columns;
    if (crossTab && cols.length > MAX_SERIES) {
      const keep = timeOnly(config.columns)
        ? cols.slice(-MAX_SERIES)
        : [...cols]
            .sort((a, b) => (measureValue(pivot.columnTotals.get(b.key)?.totals ?? emptyTotals(), chartField as MeasureKey) ?? -Infinity) - (measureValue(pivot.columnTotals.get(a.key)?.totals ?? emptyTotals(), chartField as MeasureKey) ?? -Infinity))
            .slice(0, MAX_SERIES);
      cols = cols.filter((c) => keep.includes(c));
      notes.push(`Showing ${MAX_SERIES} of ${pivot.columns.length} ${config.columns.map((f) => FIELDS[f].label).join(" › ")} series`);
    }

    const series = crossTab ? cols.map((c, i) => ({ key: `s${i}`, label: c.label })) : [{ key: "s0", label: fieldValueLabel(chartField) }];
    const data = cats.map((row) => {
      const o: Record<string, string | number | null> = { name: labelOf(row) };
      series.forEach((s, i) => {
        o[s.key] = cell(row, crossTab ? cols[i].key : null);
      });
      return o;
    });

    // Pie: one slice per row from the row total, biggest first; everything past the palette folds into "Other".
    const slices = rows
      .map((row) => ({ name: labelOf(row), value: valueOf(row, { id: "", colKey: null, group: "", field: chartField }) ?? 0 }))
      .filter((s) => s.value > 0)
      .sort((a, b) => b.value - a.value);
    const pie = slices.slice(0, MAX_SERIES);
    const rest = slices.slice(MAX_SERIES).reduce((sum, s) => sum + s.value, 0);
    if (rest > 0) pie.push({ name: "Other", value: rest });

    const rowText = config.rows.map((f) => FIELDS[f].label).join(" › ") || "all records";
    const colText = crossTab ? `, by ${config.columns.map((f) => FIELDS[f].label).join(" › ")}` : "";
    return {
      model: { series, rows: data, pie },
      note: notes.join(" · "),
      title: `${fieldValueLabel(chartField)} by ${rowText}${colText} · ${monthFrom} to ${monthTo}`,
    };
  }, [isChartView, chartField, chartUnsuitable, rows, pivot, config.rows, config.columns, topN, monthFrom, monthTo]);

  // Map: geography is taken from the deepest place field in Rows (or chosen here); the other
  // fields/filters still narrow the records that are summed into each area.
  const rowGeoLevel = GEO_ROW_LEVELS.find((g) => config.rows.includes(g.field))?.level ?? null;
  const mapLevel: GeoLevel = mapLevelSel ?? rowGeoLevel ?? "district";
  const mapStats = useMemo(() => {
    const stats = new Map<string, AreaStat>();
    if (view !== "map" || !chartField) return stats;
    for (const r of filtered) {
      const key = mapLevel === "division" ? canonicalGeoName(r.divisionName) : mapLevel === "district" ? canonicalGeoName(r.districtName) : upazilaMatchKey(r.upazilaName);
      let s = stats.get(key);
      if (!s) {
        s = { key, label: mapLevel === "division" ? r.divisionName : mapLevel === "district" ? r.districtName : r.upazilaName, totals: emptyTotals(), value: null };
        stats.set(key, s);
      }
      addRecord(s.totals, r);
    }
    for (const [key, s] of stats) {
      if (casesOnly && s.totals.cases < 1) stats.delete(key);
      else s.value = measureValue(s.totals, chartField as MeasureKey);
    }
    return stats;
  }, [view, chartField, filtered, mapLevel, casesOnly]);
  const mapBreaks = useMemo(
    () => (chartField === "cases" ? CASE_BREAKS[mapLevel] : quantileBreaks([...mapStats.values()].map((s) => s.value).filter((v): v is number => v !== null))),
    [chartField, mapLevel, mapStats],
  );
  const mapTitle = chartField ? `${fieldValueLabel(chartField)} by ${GEO_LEVELS[mapLevel].label.toLowerCase().replace(/s$/, "")} · ${monthFrom} to ${monthTo}` : "";

  const viewReady = view === "map" ? chartField !== null : isChartView && chart !== null && chart.model.rows.length > 0;

  const dimCount = Math.max(config.rows.length, 1);
  const dimsWidth = dimCount * DIM_WIDTH;

  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin: HEADER_HEIGHT,
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: valueColumns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => VALUE_WIDTH,
    overscan: 4,
    scrollMargin: dimsWidth,
  });
  const valuesWidth = colVirtualizer.getTotalSize();
  const totalWidth = dimsWidth + valuesWidth;
  const virtualCols = colVirtualizer.getVirtualItems();

  const dropField = (zone: Zone, key: FieldKey) => {
    setConfig((c) => addField(c, zone, key));
    setFilterSel((s) => ({ ...s, [key]: undefined })); // a field newly (re)placed starts unrestricted
    setSort(null);
  };
  const toggleSort = (id: string) =>
    setSort((s) => (s?.id === id ? (s.dir === -1 ? { id, dir: 1 } : null) : { id, dir: -1 }));
  const sortMark = (id: string) => (sort?.id === id ? (sort.dir === -1 ? " ▼" : " ▲") : "");

  /* ------------------------------ Exports ------------------------------ */

  type ExportEntry = { labels: string[]; values: (number | null)[] };

  function exportModel() {
    const dimLabels = config.rows.length ? config.rows.map((f) => FIELDS[f].label) : ["Scope"];
    const values = (row: PivotRow) => valueColumns.map((vc) => valueOf(row, vc));
    const body: ExportEntry[] = rows.map((row) => ({ labels: config.rows.length ? row.labels : ["All records"], values: values(row) }));
    const total: ExportEntry = { labels: dimLabels.map((_, i) => (i === 0 ? "Grand total" : "")), values: values(totalRow) };
    return { dimLabels, body, total };
  }

  function describeConfig() {
    const r = config.rows.map((f) => FIELDS[f].label).join(" › ") || "—";
    const c = config.columns.map((f) => FIELDS[f].label).join(" › ") || "—";
    const f = config.filters
      .map((k) => {
        const sel = filterSel[k];
        return sel === undefined ? null : `${FIELDS[k].label} (${sel.length} of ${filterValues.get(k)?.length ?? "?"})`;
      })
      .filter(Boolean)
      .join(", ");
    const districtSummary = districtPick.length
      ? districtPick.map((p) => (p === ENDEMIC_TOKEN ? "Endemic Districts" : (districtOptions.find((o) => o.key === p)?.label ?? p))).join(", ")
      : "All";
    return `Rows: ${r}  |  Columns: ${c}  |  Division: ${division || "All"}  |  Districts: ${districtSummary}${casesOnly ? "  |  Cases >= 1 only" : ""}  |  Period: ${monthFrom} to ${monthTo}${f ? `  |  Filters: ${f}` : ""}`;
  }

  /** The data behind the current chart/map view as a sheet (row index 3 is always the header row). */
  function viewSheet(): { name: string; aoa: (string | number | null)[][] } | null {
    if (view === "map" && chartField) {
      const list = [...mapStats.values()].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
      return {
        name: "Map data",
        aoa: [
          [BUILT_BY], [mapTitle], [],
          [LEVEL_NAME[mapLevel], fieldValueLabel(chartField), "Confirmed cases", "Deaths", "Tested"],
          ...list.map((s) => [s.label, s.value === null ? null : Math.round(s.value * 100) / 100, s.totals.cases, s.totals.deaths, s.totals.tests]),
        ],
      };
    }
    if (isChartView && chart && chartField) {
      if (view === "pie") {
        return { name: "Chart data", aoa: [[BUILT_BY], [chart.title], [], ["Slice", fieldValueLabel(chartField)], ...chart.model.pie.map((s) => [s.name, s.value])] };
      }
      const { series, rows: data } = chart.model;
      return {
        name: "Chart data",
        aoa: [[BUILT_BY], [chart.title], [], [config.rows.map((f) => FIELDS[f].label).join(" › ") || "Scope", ...series.map((s) => s.label)], ...data.map((r) => [String(r.name), ...series.map((s) => r[s.key] ?? null)])],
      };
    }
    return null;
  }

  /** The element holding the chart or map currently on screen, for PNG capture. */
  const viewNode = () => (view === "map" ? mapRef.current : isChartView ? chartRef.current : null);

  async function exportPng() {
    const node = viewNode();
    if (!node) return;
    setExporting("png");
    try {
      downloadDataUrl(await captureNodePng(node), `${fileStem()}-${view}`);
    } catch (err) {
      console.error("PNG export failed", err);
      window.alert("Could not create the image. Please try again.");
    } finally {
      setExporting(null);
    }
  }

  async function exportXlsx() {
    setExporting("xlsx");
    try {
      const XLSX = await import("xlsx");
      const { dimLabels, body, total } = exportModel();
      const crossTab = config.columns.length > 0;
      const toCells = (e: ExportEntry) => [
        ...e.labels,
        ...e.values.map((v, i) => (v === null ? null : isIndicator(valueColumns[i].field) ? Math.round(v * 100) / 100 : v)),
      ];
      const header1 = [...dimLabels, ...valueColumns.map((vc) => (crossTab ? vc.group : fieldValueLabel(vc.field)))];
      const header2 = [...dimLabels.map(() => ""), ...valueColumns.map((vc) => fieldValueLabel(vc.field))];
      // Two banner rows carry the credit line at the top and bottom of every exported sheet.
      const bannerRows = 2;
      const aoa = [
        [BUILT_BY],
        [],
        ...(crossTab ? [header1, header2] : [header1]),
        ...body.map(toCells),
        toCells(total),
        [],
        [BUILT_BY],
      ];

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      if (crossTab) {
        const merges: Range[] = dimLabels.map((_, c) => ({ s: { r: bannerRows, c }, e: { r: bannerRows + 1, c } }));
        let start = 0;
        valueColumns.forEach((vc, i) => {
          const next = valueColumns[i + 1];
          if (!next || next.group !== vc.group) {
            if (i > start) merges.push({ s: { r: bannerRows, c: dimLabels.length + start }, e: { r: bannerRows, c: dimLabels.length + i } });
            start = i + 1;
          }
        });
        ws["!merges"] = merges;
      }
      ws["!cols"] = [...dimLabels.map(() => ({ wch: 24 })), ...valueColumns.map(() => ({ wch: 14 }))];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Pivot");
      // The chosen chart/map view travels with the workbook as its own sheet of exactly what is plotted,
      // ready for Excel's Insert → Chart (the file format used here can't embed a picture — PNG/PDF do).
      const extra = viewSheet();
      if (extra) {
        const sheet = XLSX.utils.aoa_to_sheet(extra.aoa);
        sheet["!cols"] = [{ wch: 32 }, ...extra.aoa[3].slice(1).map(() => ({ wch: 16 }))];
        XLSX.utils.book_append_sheet(wb, sheet, extra.name);
      }
      XLSX.writeFile(wb, `${fileStem()}.xlsx`);
    } finally {
      setExporting(null);
    }
  }

  async function exportPdf() {
    setExporting("pdf");
    try {
      const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
      const { dimLabels, body, total } = exportModel();
      const fmt = (e: ExportEntry) => [...e.labels, ...e.values.map((v, i) => formatFieldValue(valueColumns[i].field, v))];

      const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: valueColumns.length > 12 ? "a3" : "a4" });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const drawHeader = () => {
        doc.setFontSize(13);
        doc.setTextColor(15, 23, 42);
        doc.text("Malaria MIS - Pivot report", 28, 30);
        doc.setFontSize(8);
        doc.text(describeConfig(), 28, 44);
        doc.text(BUILT_BY, pageWidth - 28, 20, { align: "right" });
      };
      const drawFooter = () => {
        doc.setFontSize(7);
        doc.setTextColor(148, 163, 184);
        doc.text(BUILT_BY, pageWidth - 28, pageHeight - 10, { align: "right" });
      };
      drawHeader();

      // Chart/map views: the picture gets the first page, the table that backs it follows.
      const node = viewNode();
      if (node) {
        const image = await captureNodePng(node);
        const props = doc.getImageProperties(image);
        const maxW = pageWidth - 56;
        const maxH = pageHeight - 54 - 30;
        const scale = Math.min(maxW / props.width, maxH / props.height);
        const w = props.width * scale;
        const h = props.height * scale;
        doc.addImage(image, "PNG", 28 + (maxW - w) / 2, 54, w, h);
        drawFooter();
        doc.addPage();
        drawHeader();
      }

      autoTable(doc, {
        startY: 54,
        head: [[...dimLabels, ...valueColumns.map((vc) => (vc.group ? `${vc.group}\n${fieldValueLabel(vc.field)}` : fieldValueLabel(vc.field)))]],
        body: body.map(fmt),
        foot: [fmt(total)],
        showFoot: "lastPage",
        margin: { left: 28, right: 28, bottom: 26 },
        styles: { fontSize: 6.5, cellPadding: 2, overflow: "linebreak" },
        headStyles: { fillColor: [30, 41, 59], halign: "center" },
        footStyles: { fillColor: [226, 232, 240], textColor: [15, 23, 42], fontStyle: "bold" },
        columnStyles: Object.fromEntries(valueColumns.map((_, i) => [dimLabels.length + i, { halign: "right" as const }])),
        horizontalPageBreak: true,
        horizontalPageBreakRepeat: dimLabels.map((_, i) => i),
        didDrawPage: drawFooter,
      });
      doc.save(`${fileStem()}.pdf`);
    } finally {
      setExporting(null);
    }
  }

  /* ------------------------------ Rendering ----------------------------- */

  const renderDimCells = (labels: string[], className: string) =>
    Array.from({ length: dimCount }, (_, i) => (
      <div
        key={i}
        title={labels[i]}
        className={`sticky z-10 flex h-full flex-none items-center truncate border-r border-slate-200 px-2 text-sm ${className}`}
        style={{ left: i * DIM_WIDTH, width: DIM_WIDTH }}
      >
        <span className="truncate">{labels[i] ?? ""}</span>
      </div>
    ));

  const renderValueCells = (row: PivotRow, bold = false) => (
    <div className="relative h-full flex-none" style={{ width: valuesWidth }}>
      {virtualCols.map((col) => {
        const vc = valueColumns[col.index];
        return (
          <div
            key={vc.id}
            className={`absolute top-0 flex h-full items-center justify-end border-r border-slate-100 px-2 text-sm tabular-nums ${
              FIELDS[vc.field].kind === "measure" && isIndicator(vc.field) ? "text-emerald-800" : "text-slate-800"
            } ${vc.colKey === null && config.columns.length > 0 ? "bg-slate-50" : ""} ${bold ? "font-semibold" : ""}`}
            style={{ left: col.start - dimsWidth, width: col.size }}
          >
            {formatFieldValue(vc.field, valueOf(row, vc))}
          </div>
        );
      })}
    </div>
  );

  // Every field is available to every zone, and picking one for a zone removes it from the
  // others' "+ Add" lists — the same pool is passed to all three pickers.
  const usedFields = new Set<FieldKey>([...config.rows, ...config.columns, ...config.values, ...config.filters]);
  const availableFields = ALL_FIELDS.filter((f) => !usedFields.has(f.key));
  // Derived ratios (TPR, API, …) have no meaningful list of discrete values to tick, so they aren't offered as filters.
  const filterOptions = availableFields.filter((f) => f.tone !== "indicator");

  return (
    <div className="space-y-3">
      {/* Field configuration — one compact bar; nothing but the current picks is shown until you click "+ Add". */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-200 bg-white p-2.5">
        <FieldPickerGroup
          label="Rows"
          hint={`Nested left → right, max ${MAX_FIELDS}`}
          tags={config.rows.map((key) => ({
            key, label: FIELDS[key].label, tone: toneOf(key),
            onRemove: () => setConfig((c) => ({ ...c, rows: c.rows.filter((k) => k !== key) })),
          }))}
          options={availableFields}
          onAdd={(key) => dropField("rows", key as FieldKey)}
          disabled={config.rows.length >= MAX_FIELDS}
        />
        <div className="h-6 w-px bg-slate-200" aria-hidden />
        <FieldPickerGroup
          label="Columns"
          hint={`Nested left → right for cross-tab, max ${MAX_FIELDS}`}
          tags={config.columns.map((key) => ({
            key, label: FIELDS[key].label, tone: toneOf(key),
            onRemove: () => setConfig((c) => ({ ...c, columns: c.columns.filter((k) => k !== key) })),
          }))}
          options={availableFields}
          onAdd={(key) => dropField("columns", key as FieldKey)}
          disabled={config.columns.length >= MAX_FIELDS}
        />
        <div className="h-6 w-px bg-slate-200" aria-hidden />
        <FieldPickerGroup
          label="Values"
          hint="Counts are summed, indicators derived from sums; a place or time field here counts its distinct values"
          tags={config.values.map((key) => ({
            key, label: fieldValueLabel(key), tone: toneOf(key),
            onRemove: () => setConfig((c) => ({ ...c, values: c.values.filter((v) => v !== key) })),
          }))}
          options={availableFields}
          onAdd={(key) => dropField("values", key as FieldKey)}
        />
        <div className="h-6 w-px bg-slate-200" aria-hidden />
        <FieldPickerGroup
          label="Filters"
          hint="Optional — restrict the report to chosen values of a field (leave empty for no filter)"
          customTags={config.filters.map((key) => (
            <FilterTag
              key={key}
              label={FIELDS[key].label}
              tone={toneOf(key)}
              allValues={filterValues.get(key) ?? []}
              selected={filterSel[key]}
              onChange={(next) => setFilterSel((s) => ({ ...s, [key]: next }))}
              onRemove={() => {
                setConfig((c) => ({ ...c, filters: c.filters.filter((k) => k !== key) }));
                setFilterSel((s) => ({ ...s, [key]: undefined }));
              }}
            />
          ))}
          options={filterOptions}
          onAdd={(key) => dropField("filters", key as FieldKey)}
        />
        <span className="ml-auto text-[11px] text-slate-400">
          API &amp; ABER use population from <b>{dataset.populationSource ?? "— (not imported)"}</b>
        </span>
      </div>

      {/* Output — how the result is shown, and what the downloads contain. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-slate-200 bg-white p-2.5 text-xs">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">View as</span>
        <div role="tablist" aria-label="Output view" className="flex flex-wrap gap-1">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={view === v.key}
              onClick={() => setView(v.key)}
              className={`rounded-md border px-2.5 py-1 font-medium ${view === v.key ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-indigo-300 hover:text-indigo-700"}`}
            >
              {v.label}
            </button>
          ))}
        </div>
        {view !== "table" && measureFields.length > 0 && (
          <label className="flex items-center gap-1 text-slate-600" title="A chart has one value axis, so one measure is plotted at a time">
            Plot
            <select value={chartField ?? ""} onChange={(e) => setPlotField(e.target.value as FieldKey)} className="max-w-44 rounded border border-slate-300 px-1.5 py-1">
              {measureFields.map((f) => (
                <option key={f} value={f}>{fieldValueLabel(f)}</option>
              ))}
            </select>
          </label>
        )}
        {isChartView && view !== "pie" && (
          <label className="flex items-center gap-1 text-slate-600">
            Show
            <select value={topN} onChange={(e) => setTopN(Number(e.target.value))} className="rounded border border-slate-300 px-1.5 py-1">
              {TOP_N_CHOICES.map((n) => (
                <option key={n} value={n}>{n === 0 ? "All rows" : `${n} rows`}</option>
              ))}
            </select>
          </label>
        )}
        {view === "map" && (
          <label className="flex items-center gap-1 text-slate-600">
            Map by
            <select value={mapLevel} onChange={(e) => setMapLevelSel(e.target.value as GeoLevel)} className="rounded border border-slate-300 px-1.5 py-1">
              {(Object.keys(LEVEL_NAME) as GeoLevel[]).map((l) => (
                <option key={l} value={l}>{LEVEL_NAME[l]}</option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={() => {
            setConfig((c) => ({ ...c, rows: c.columns, columns: c.rows }));
            setSort(null);
          }}
          title="Swap the Rows and Columns fields"
          className="ml-auto rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
        >
          ⇄ Swap rows &amp; columns
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 text-sm">
          <select
            value={division}
            onChange={(e) => setDivision(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1.5"
            aria-label="Division filter"
          >
            <option value="">All divisions</option>
            {divisions.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <DistrictPicker options={districtOptions} picked={districtPick} onChange={setDistrictPick} />
          <label className="flex items-center gap-1 text-xs text-slate-600">
            From
            <input type="month" value={monthFrom} min={periodBounds.min} max={periodBounds.max}
              onChange={(e) => setMonthFrom(e.target.value)} className="rounded border border-slate-300 px-2 py-1 text-sm" aria-label="From month" />
          </label>
          <label className="flex items-center gap-1 text-xs text-slate-600">
            To
            <input type="month" value={monthTo} min={periodBounds.min} max={periodBounds.max}
              onChange={(e) => setMonthTo(e.target.value)} className="rounded border border-slate-300 px-2 py-1 text-sm" aria-label="To month" />
          </label>
          <button
            type="button"
            onClick={() => {
              const end = periodIndex(periodBounds.max);
              if (end === null) return;
              setMonthFrom(periodString(end - 11));
              setMonthTo(periodBounds.max);
            }}
            className="rounded border border-slate-300 px-2 py-1.5 text-xs hover:bg-slate-50"
          >
            Last 12 months
          </button>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter rows…"
            className="w-48 rounded border border-slate-300 px-2 py-1.5"
          />
          <button
            type="button"
            onClick={() => {
              setConfig(DEFAULT_CONFIG);
              setFilterSel({});
              setPlotField(null);
              setMapLevelSel(null);
              setHideTotals(false);
              setSort(null);
              setQuery("");
              setDivision("");
              setDistrictPick([]);
              setCasesOnly(false);
              setMonthFrom(periodBounds.min);
              setMonthTo(periodBounds.max);
            }}
            className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-50"
          >
            Reset
          </button>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-700" title="Hide result rows that have no confirmed cases (totals then cover only the rows shown)">
            <input type="checkbox" checked={casesOnly} onChange={(e) => setCasesOnly(e.target.checked)} />
            Cases ≥ 1 only
          </label>
          <label
            className={`flex items-center gap-1.5 text-xs ${config.columns.length ? "cursor-pointer text-slate-700" : "cursor-not-allowed text-slate-400"}`}
            title={config.columns.length ? "Hide the Grand total column(s) at the end of each row — the individual column data stays" : "Needs a field in Columns — without one, each value column is already the row total"}
          >
            <input
              type="checkbox"
              checked={hideTotals && config.columns.length > 0}
              disabled={config.columns.length === 0}
              onChange={(e) => {
                setHideTotals(e.target.checked);
                setSort(null);
              }}
            />
            Hide total columns
          </label>
          <span className="ml-auto text-xs text-slate-500">
            {rows.length.toLocaleString("en-US")} rows × {valueColumns.length.toLocaleString("en-US")} value columns
          </span>
          {view !== "table" && (
            <button
              type="button"
              disabled={exporting !== null || !viewReady}
              onClick={exportPng}
              title={`Download the ${view === "map" ? "map" : "chart"} as a PNG picture`}
              className="rounded bg-indigo-700 px-3 py-1.5 font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
            >
              {exporting === "png" ? "Exporting…" : "Export .png"}
            </button>
          )}
          <button
            type="button"
            disabled={exporting !== null || config.values.length === 0}
            onClick={exportXlsx}
            className="rounded bg-emerald-700 px-3 py-1.5 font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {exporting === "xlsx" ? "Exporting…" : "Export .xlsx"}
          </button>
          <button
            type="button"
            disabled={exporting !== null || config.values.length === 0}
            onClick={exportPdf}
            className="rounded bg-rose-700 px-3 py-1.5 font-medium text-white hover:bg-rose-600 disabled:opacity-50"
          >
            {exporting === "pdf" ? "Exporting…" : "Export .pdf"}
          </button>
        </div>

        {/* Chart / map output */}
        {config.values.length > 0 && view !== "table" ? (
          <div className="rounded-lg border border-slate-200 bg-white p-2">
            {!chartField ? (
              <p className="p-8 text-center text-sm text-slate-500">
                Charts and maps plot a count or an indicator — add one (for example Confirmed cases) to Values.
              </p>
            ) : chartUnsuitable ? (
              <p className="p-8 text-center text-sm text-slate-500">
                The {view} view adds values together, which doesn&apos;t work for a rate such as {fieldValueLabel(chartField)}. Plot a count (cases, deaths, tests …) here, or choose Column, Bar, Line or Area.
              </p>
            ) : view === "map" ? (
              <div ref={mapRef} className="bg-white p-3">
                <h4 className="mb-2 text-sm font-semibold text-slate-800">{mapTitle}</h4>
                <div className="h-[60vh] min-h-72">
                  <ChoroplethMap level={mapLevel} parentKey={null} selectedKey={null} stats={mapStats} breaks={mapBreaks} metric={chartField as MeasureKey} onSelect={noopSelect} />
                </div>
                <p className="mt-1.5 text-[11px] text-slate-500">
                  Each area sums every record that passes the filters and period; Rows and Columns don&apos;t split the map.
                </p>
              </div>
            ) : chart && chart.model.rows.length > 0 ? (
              <>
                {chart.note && view !== "pie" && <p className="px-3 pt-1 text-[11px] text-amber-700">{chart.note} — narrow with Filters or raise “Show”.</p>}
                <PivotChart kind={view as ChartKind} model={chart.model} title={chart.title} format={(v) => formatFieldValue(chartField, v)} captureRef={chartRef} />
              </>
            ) : (
              <p className="p-8 text-center text-sm text-slate-500">No data for this selection.</p>
            )}
          </div>
        ) : config.values.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            Add at least one field to Values.
          </div>
        ) : (
          <div ref={scrollRef} className="relative h-[65vh] overflow-auto rounded-lg border border-slate-200 bg-white">
            <div style={{ width: totalWidth, minWidth: "100%" }}>
              {/* Header */}
              <div className="sticky top-0 z-20 flex border-b border-slate-300 bg-slate-100" style={{ height: HEADER_HEIGHT, width: totalWidth }}>
                {Array.from({ length: dimCount }, (_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => config.rows[i] && toggleSort(`dim:${i}`)}
                    className="sticky z-30 flex h-full flex-none items-end border-r border-slate-300 bg-slate-100 px-2 pb-1.5 text-left text-xs font-semibold text-slate-700 hover:bg-slate-200"
                    style={{ left: i * DIM_WIDTH, width: DIM_WIDTH }}
                  >
                    {config.rows[i] ? FIELDS[config.rows[i]].label : "Scope"}
                    {sortMark(`dim:${i}`)}
                  </button>
                ))}
                <div className="relative h-full flex-none" style={{ width: valuesWidth }}>
                  {virtualCols.map((col) => {
                    const vc = valueColumns[col.index];
                    return (
                      <button
                        key={vc.id}
                        type="button"
                        onClick={() => toggleSort(vc.id)}
                        title={FIELDS[vc.field].title}
                        className="absolute top-0 flex h-full flex-col items-end justify-center border-r border-slate-200 px-2 text-right hover:bg-slate-200"
                        style={{ left: col.start - dimsWidth, width: col.size }}
                      >
                        {vc.group && <span className="w-full truncate text-[11px] font-semibold text-slate-500">{vc.group}</span>}
                        <span className="w-full truncate text-xs font-semibold text-slate-800">
                          {fieldValueLabel(vc.field)}
                          {sortMark(vc.id)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Body */}
              <div className="relative" style={{ height: rowVirtualizer.getTotalSize() }}>
                {rowVirtualizer.getVirtualItems().map((vr) => {
                  const row = rows[vr.index];
                  return (
                    <div
                      key={row.key}
                      className="group absolute left-0 top-0 flex border-b border-slate-100"
                      style={{ height: ROW_HEIGHT, width: totalWidth, transform: `translateY(${vr.start - HEADER_HEIGHT}px)` }}
                    >
                      {renderDimCells(config.rows.length ? row.labels : ["All records"], "bg-white text-slate-800 group-hover:bg-sky-50")}
                      {renderValueCells(row)}
                    </div>
                  );
                })}
              </div>

              {/* Grand total */}
              <div className="sticky bottom-0 z-20 flex border-t-2 border-slate-300 bg-slate-100" style={{ height: ROW_HEIGHT, width: totalWidth }}>
                {renderDimCells(["Grand total"], "bg-slate-100 font-semibold text-slate-900")}
                {renderValueCells(totalRow, true)}
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
