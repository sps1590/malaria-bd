"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Range } from "xlsx";
import { BUILT_BY } from "@/components/ChartTools";
import {
  INDICATORS,
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
}

const DEFAULT_CONFIG: PivotConfig = {
  rows: ["divisionName", "districtName"],
  columns: ["year"],
  values: ["cases", "tests", "tpr", "api"],
};

type Zone = "rows" | "columns" | "values";
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

function buildValueColumns(columns: PivotColumn[], fields: FieldKey[], crossTab: boolean): ValueColumn[] {
  if (!crossTab) return fields.map((f) => ({ id: f, colKey: null, group: "", field: f }));
  return [
    ...columns.flatMap((c) => fields.map((f) => ({ id: `${c.key}${KEY_SEP}${f}`, colKey: c.key, group: c.label, field: f }))),
    ...fields.map((f) => ({ id: `__total${KEY_SEP}${f}`, colKey: null, group: "Grand total", field: f })),
  ];
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
  if (zone === "rows") return rows.length >= MAX_FIELDS ? cfg : { rows: [...rows, key], columns, values };
  if (zone === "columns") return columns.length >= MAX_FIELDS ? cfg : { rows, columns: [...columns, key], values };
  return { rows, columns, values: [...values, key] };
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
  options,
  onAdd,
  disabled,
}: {
  label: string;
  hint: string;
  tags: { key: string; label: string; tone: "dimension" | "count" | "indicator"; onRemove: () => void }[];
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
      {tags.map((t) => (
        <FieldTag key={t.key} label={t.label} tone={t.tone} onRemove={t.onRemove} />
      ))}
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
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [exporting, setExporting] = useState<"xlsx" | "pdf" | null>(null);

  const filtered = useMemo(() => {
    const a = periodIndex(monthFrom) ?? -Infinity;
    const b = periodIndex(monthTo) ?? Infinity;
    const [from, to] = a <= b ? [a, b] : [b, a];
    return records.filter((r) => {
      const t = r.year * 12 + r.month - 1;
      return t >= from && t <= to && (!division || r.divisionName === division);
    });
  }, [records, division, monthFrom, monthTo]);
  // Dimension fields placed in Values are aggregated as a distinct count, so the pivot engine
  // needs to know which fields to track Sets for.
  const distinctValueFields = useMemo(() => config.values.filter((f) => FIELDS[f].kind === "dimension"), [config.values]);
  const pivot = useMemo(
    () => buildPivot(filtered, config.rows, config.columns, distinctValueFields),
    [filtered, config.rows, config.columns, distinctValueFields],
  );
  const valueColumns = useMemo(
    () => buildValueColumns(pivot.columns, config.values, config.columns.length > 0),
    [pivot.columns, config.values, config.columns],
  );
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? pivot.rows.filter((r) => r.labels.some((l) => l.toLowerCase().includes(q))) : pivot.rows;
  }, [pivot.rows, query]);
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
    return `Rows: ${r}  |  Columns: ${c}  |  Division: ${division || "All"}  |  Period: ${monthFrom} to ${monthTo}`;
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
      doc.setFontSize(13);
      doc.text("Malaria MIS - Pivot report", 28, 30);
      doc.setFontSize(8);
      doc.text(describeConfig(), 28, 44);
      doc.text(BUILT_BY, pageWidth - 28, 20, { align: "right" });

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
        didDrawPage: () => {
          doc.setFontSize(7);
          doc.setTextColor(148, 163, 184);
          doc.text(BUILT_BY, pageWidth - 28, pageHeight - 10, { align: "right" });
        },
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
  const usedFields = new Set<FieldKey>([...config.rows, ...config.columns, ...config.values]);
  const availableFields = ALL_FIELDS.filter((f) => !usedFields.has(f.key));

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
        <span className="ml-auto text-[11px] text-slate-400">
          API &amp; ABER use population from <b>{dataset.populationSource ?? "— (not imported)"}</b>
        </span>
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
              setSort(null);
              setQuery("");
              setDivision("");
              setMonthFrom(periodBounds.min);
              setMonthTo(periodBounds.max);
            }}
            className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-50"
          >
            Reset
          </button>
          <span className="ml-auto text-xs text-slate-500">
            {rows.length.toLocaleString("en-US")} rows × {valueColumns.length.toLocaleString("en-US")} value columns
          </span>
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

        {/* Virtualized grid */}
        {config.values.length === 0 ? (
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
