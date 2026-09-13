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

interface Dimension {
  label: string;
  value: (r: MisRecord) => string;
  key?: (r: MisRecord) => string;
  compare?: (a: string, b: string) => number;
}

const MONTH_ORDER = new Map<string, number>(MONTHS.map((m, i) => [m, i]));
const naturalCompare = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

const DIMENSIONS: Record<DimensionKey, Dimension> = {
  divisionName: { label: "Division", value: (r) => r.divisionName },
  districtName: { label: "District", value: (r) => r.districtName, key: (r) => String(r.districtId) },
  upazilaName: { label: "Upazila", value: (r) => r.upazilaName, key: (r) => String(r.upazilaId) },
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

const MAX_ROW_FIELDS = 3;
const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 52;
const DIM_WIDTH = 190;
const VALUE_WIDTH = 124;
const KEY_SEP = "␟";

interface PivotConfig {
  rows: DimensionKey[];
  column: DimensionKey | null;
  values: MeasureKey[];
}

const DEFAULT_CONFIG: PivotConfig = {
  rows: ["divisionName", "districtName"],
  column: "year",
  values: ["cases", "tests", "tpr", "api"],
};

type FieldRef = { kind: "dimension"; key: DimensionKey } | { kind: "measure"; key: MeasureKey };
type Zone = "rows" | "column" | "values";
type SortState = { id: string; dir: 1 | -1 } | null;

interface PivotRow {
  key: string;
  labels: string[];
  cells: Map<string, Totals>;
  total: Totals;
}
interface PivotColumn {
  key: string;
  label: string;
}
interface PivotResult {
  rows: PivotRow[];
  columns: PivotColumn[];
  columnTotals: Map<string, Totals>;
  grandTotal: Totals;
}
interface ValueColumn {
  id: string;
  colKey: string | null; // null → row total
  group: string;
  measure: MeasureKey;
}

/* ------------------------------ Pivot engine ----------------------------- */

const dimensionKey = (d: DimensionKey, r: MisRecord) => (DIMENSIONS[d].key ?? DIMENSIONS[d].value)(r);

function getOrCreate(map: Map<string, Totals>, key: string): Totals {
  let t = map.get(key);
  if (!t) map.set(key, (t = emptyTotals()));
  return t;
}

function buildPivot(records: readonly MisRecord[], rowDims: DimensionKey[], columnDim: DimensionKey | null): PivotResult {
  const rowMap = new Map<string, PivotRow>();
  const columnLabels = new Map<string, string>();
  const columnTotals = new Map<string, Totals>();
  const grandTotal = emptyTotals();

  for (const record of records) {
    const rowKey = rowDims.length ? rowDims.map((d) => dimensionKey(d, record)).join(KEY_SEP) : "__all";
    let row = rowMap.get(rowKey);
    if (!row) {
      row = { key: rowKey, labels: rowDims.map((d) => DIMENSIONS[d].value(record)), cells: new Map(), total: emptyTotals() };
      rowMap.set(rowKey, row);
    }
    addRecord(row.total, record);
    addRecord(grandTotal, record);

    if (columnDim) {
      const colKey = dimensionKey(columnDim, record);
      if (!columnLabels.has(colKey)) columnLabels.set(colKey, DIMENSIONS[columnDim].value(record));
      addRecord(getOrCreate(row.cells, colKey), record);
      addRecord(getOrCreate(columnTotals, colKey), record);
    }
  }

  const rows = [...rowMap.values()].sort((a, b) => {
    for (let i = 0; i < rowDims.length; i++) {
      const c = (DIMENSIONS[rowDims[i]].compare ?? naturalCompare)(a.labels[i], b.labels[i]);
      if (c) return c;
    }
    return 0;
  });
  const columnCompare = columnDim ? (DIMENSIONS[columnDim].compare ?? naturalCompare) : naturalCompare;
  const columns = [...columnLabels].map(([key, label]) => ({ key, label })).sort((a, b) => columnCompare(a.label, b.label));

  return { rows, columns, columnTotals, grandTotal };
}

function buildValueColumns(columns: PivotColumn[], measures: MeasureKey[], crossTab: boolean): ValueColumn[] {
  if (!crossTab) return measures.map((m) => ({ id: m, colKey: null, group: "", measure: m }));
  return [
    ...columns.flatMap((c) => measures.map((m) => ({ id: `${c.key}${KEY_SEP}${m}`, colKey: c.key, group: c.label, measure: m }))),
    ...measures.map((m) => ({ id: `__total${KEY_SEP}${m}`, colKey: null, group: "Grand total", measure: m })),
  ];
}

function valueOf(row: PivotRow, vc: ValueColumn): number | null {
  const t = vc.colKey === null ? row.total : row.cells.get(vc.colKey);
  return t ? measureValue(t, vc.measure) : null;
}

const TIME_DIMS = new Set<DimensionKey>(["year", "quarter", "yearMonth", "month"]);

/**
 * Default order (no header sort chosen): time dimensions stay chronological; place dimensions go
 * from the most to the fewest cases (or deaths when deaths is the first value), group by group.
 */
function defaultOrder(rows: PivotRow[], dims: DimensionKey[], firstMeasure: MeasureKey | undefined): PivotRow[] {
  if (!dims.length || dims.every((d) => TIME_DIMS.has(d))) return rows;
  const basis = firstMeasure === "deaths" ? "deaths" : "cases";
  const groupTotal = new Map<string, number>();
  for (const row of rows) {
    for (let i = 0; i < dims.length; i++) {
      const key = row.labels.slice(0, i + 1).join(KEY_SEP);
      groupTotal.set(key, (groupTotal.get(key) ?? 0) + row.total[basis]);
    }
  }
  return [...rows].sort((a, b) => {
    for (let i = 0; i < dims.length; i++) {
      if (TIME_DIMS.has(dims[i])) {
        const c = (DIMENSIONS[dims[i]].compare ?? naturalCompare)(a.labels[i], b.labels[i]);
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

function sortRows(rows: PivotRow[], sort: SortState, dims: DimensionKey[], valueColumns: ValueColumn[], firstMeasure?: MeasureKey): PivotRow[] {
  if (!sort) return defaultOrder(rows, dims, firstMeasure);
  const { id, dir } = sort;
  if (id.startsWith("dim:")) {
    const index = Number(id.slice(4));
    const dim = dims[index];
    if (!dim) return rows;
    const compare = DIMENSIONS[dim].compare ?? naturalCompare;
    return [...rows].sort((a, b) => dir * compare(a.labels[index], b.labels[index]));
  }
  const column = valueColumns.find((c) => c.id === id);
  if (!column) return rows;
  return rows
    .map((row) => ({ row, value: valueOf(row, column) }))
    .sort((a, b) => (a.value === null ? (b.value === null ? 0 : 1) : b.value === null ? -1 : dir * (a.value - b.value)))
    .map((x) => x.row);
}

function applyDrop(cfg: PivotConfig, zone: Zone, field: FieldRef): PivotConfig {
  if (zone === "values") {
    if (field.kind !== "measure" || cfg.values.includes(field.key)) return cfg;
    return { ...cfg, values: [...cfg.values, field.key] };
  }
  if (field.kind !== "dimension") return cfg;
  const rows = cfg.rows.filter((d) => d !== field.key);
  if (zone === "column") return { ...cfg, rows, column: field.key };
  if (rows.length >= MAX_ROW_FIELDS) return cfg;
  return { ...cfg, rows: [...rows, field.key], column: cfg.column === field.key ? null : cfg.column };
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
 * "+" button. Clicking "+" pops a list of the fields NOT yet used anywhere else — nothing is
 * visible until you click, and a field picked for one zone disappears from the other pickers.
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
  const pivot = useMemo(() => buildPivot(filtered, config.rows, config.column), [filtered, config.rows, config.column]);
  const valueColumns = useMemo(
    () => buildValueColumns(pivot.columns, config.values, config.column !== null),
    [pivot.columns, config.values, config.column],
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
    const cells = new Map<string, Totals>();
    const total = emptyTotals();
    for (const row of visibleRows) {
      addTotals(total, row.total);
      for (const [key, t] of row.cells) addTotals(getOrCreate(cells, key), t);
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

  const dropField = (zone: Zone, field: FieldRef) => {
    setConfig((c) => applyDrop(c, zone, field));
    setSort(null);
  };
  const toggleSort = (id: string) =>
    setSort((s) => (s?.id === id ? (s.dir === -1 ? { id, dir: 1 } : null) : { id, dir: -1 }));
  const sortMark = (id: string) => (sort?.id === id ? (sort.dir === -1 ? " ▼" : " ▲") : "");

  /* ------------------------------ Exports ------------------------------ */

  type ExportEntry = { labels: string[]; values: (number | null)[] };

  function exportModel() {
    const dimLabels = config.rows.length ? config.rows.map((d) => DIMENSIONS[d].label) : ["Scope"];
    const values = (row: PivotRow) => valueColumns.map((vc) => valueOf(row, vc));
    const body: ExportEntry[] = rows.map((row) => ({ labels: config.rows.length ? row.labels : ["All records"], values: values(row) }));
    const total: ExportEntry = { labels: dimLabels.map((_, i) => (i === 0 ? "Grand total" : "")), values: values(totalRow) };
    return { dimLabels, body, total };
  }

  function describeConfig() {
    const r = config.rows.map((d) => DIMENSIONS[d].label).join(" › ") || "—";
    const c = config.column ? DIMENSIONS[config.column].label : "—";
    return `Rows: ${r}  |  Columns: ${c}  |  Division: ${division || "All"}  |  Period: ${monthFrom} to ${monthTo}`;
  }

  async function exportXlsx() {
    setExporting("xlsx");
    try {
      const XLSX = await import("xlsx");
      const { dimLabels, body, total } = exportModel();
      const crossTab = config.column !== null;
      const toCells = (e: ExportEntry) => [
        ...e.labels,
        ...e.values.map((v, i) => (v === null ? null : isIndicator(valueColumns[i].measure) ? Math.round(v * 100) / 100 : v)),
      ];
      const header1 = [...dimLabels, ...valueColumns.map((vc) => (crossTab ? vc.group : measureLabel(vc.measure)))];
      const header2 = [...dimLabels.map(() => ""), ...valueColumns.map((vc) => measureLabel(vc.measure))];
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
      const fmt = (e: ExportEntry) => [...e.labels, ...e.values.map((v, i) => formatMeasure(valueColumns[i].measure, v))];

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
        head: [[...dimLabels, ...valueColumns.map((vc) => (vc.group ? `${vc.group}\n${measureLabel(vc.measure)}` : measureLabel(vc.measure)))]],
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
              isIndicator(vc.measure) ? "text-emerald-800" : "text-slate-800"
            } ${vc.colKey === null && config.column ? "bg-slate-50" : ""} ${bold ? "font-semibold" : ""}`}
            style={{ left: col.start - dimsWidth, width: col.size }}
          >
            {formatMeasure(vc.measure, valueOf(row, vc))}
          </div>
        );
      })}
    </div>
  );

  // Every dimension is usable in exactly one of Rows / Columns at a time; a measure in exactly one
  // Values slot. The "+ Add" popovers only ever list what's left, so a field picked for one zone
  // disappears from the others automatically.
  const usedDims = new Set<DimensionKey>(config.column ? [...config.rows, config.column] : config.rows);
  const rowOptions = DIMENSION_KEYS.filter((k) => !usedDims.has(k)).map((k) => ({ key: k, label: DIMENSIONS[k].label, tone: "dimension" as const }));
  const columnOptions = DIMENSION_KEYS.filter((k) => !config.rows.includes(k) && k !== config.column).map((k) => ({ key: k, label: DIMENSIONS[k].label, tone: "dimension" as const }));
  const valueOptions = [
    ...INDICATOR_KEYS.filter((k) => !config.values.includes(k)).map((k) => ({ key: k, label: INDICATORS[k].label, title: INDICATORS[k].formula, tone: "indicator" as const })),
    ...NUMERIC_FIELDS.filter((f) => !config.values.includes(f.key)).map((f) => ({ key: f.key, label: f.label, tone: "count" as const })),
  ];

  return (
    <div className="space-y-3">
      {/* Field configuration — one compact bar; nothing but the current picks is shown until you click "+ Add". */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-200 bg-white p-2.5">
        <FieldPickerGroup
          label="Rows"
          hint={`Nested left → right, max ${MAX_ROW_FIELDS}`}
          tags={config.rows.map((key) => ({
            key, label: DIMENSIONS[key].label, tone: "dimension",
            onRemove: () => setConfig((c) => ({ ...c, rows: c.rows.filter((d) => d !== key) })),
          }))}
          options={rowOptions}
          onAdd={(key) => dropField("rows", { kind: "dimension", key: key as DimensionKey })}
          disabled={config.rows.length >= MAX_ROW_FIELDS}
        />
        <div className="h-6 w-px bg-slate-200" aria-hidden />
        <FieldPickerGroup
          label="Columns"
          hint="One dimension for cross-tab"
          tags={config.column ? [{ key: config.column, label: DIMENSIONS[config.column].label, tone: "dimension", onRemove: () => setConfig((c) => ({ ...c, column: null })) }] : []}
          options={columnOptions}
          onAdd={(key) => dropField("column", { kind: "dimension", key: key as DimensionKey })}
          disabled={config.column !== null}
        />
        <div className="h-6 w-px bg-slate-200" aria-hidden />
        <FieldPickerGroup
          label="Values"
          hint="Counts are summed; indicators derived from sums"
          tags={config.values.map((key) => ({
            key, label: isIndicator(key) ? INDICATORS[key].label : measureLabel(key), tone: isIndicator(key) ? "indicator" : "count",
            onRemove: () => setConfig((c) => ({ ...c, values: c.values.filter((v) => v !== key) })),
          }))}
          options={valueOptions}
          onAdd={(key) => dropField("values", { kind: "measure", key: key as MeasureKey })}
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
                    {config.rows[i] ? DIMENSIONS[config.rows[i]].label : "Scope"}
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
                        title={isIndicator(vc.measure) ? INDICATORS[vc.measure].formula : undefined}
                        className="absolute top-0 flex h-full flex-col items-end justify-center border-r border-slate-200 px-2 text-right hover:bg-slate-200"
                        style={{ left: col.start - dimsWidth, width: col.size }}
                      >
                        {vc.group && <span className="w-full truncate text-[11px] font-semibold text-slate-500">{vc.group}</span>}
                        <span className="w-full truncate text-xs font-semibold text-slate-800">
                          {measureLabel(vc.measure)}
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
