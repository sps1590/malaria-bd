"use client";

import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Range } from "xlsx";
import {
  INDICATORS,
  MONTHS,
  NUMERIC_FIELDS,
  addRecord,
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
const MEASURE_KEYS: MeasureKey[] = [...NUMERIC_FIELDS.map((f) => f.key), ...INDICATOR_KEYS];

const MAX_ROW_FIELDS = 3;
const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 52;
const DIM_WIDTH = 190;
const VALUE_WIDTH = 124;
const KEY_SEP = "␟";
const DRAG_MIME = "application/x-mis-pivot-field";

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

function sortRows(rows: PivotRow[], sort: SortState, dims: DimensionKey[], valueColumns: ValueColumn[]): PivotRow[] {
  if (!sort) return rows;
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

function readField(e: DragEvent): FieldRef | null {
  try {
    const raw = JSON.parse(e.dataTransfer.getData(DRAG_MIME)) as { kind?: unknown; key?: unknown };
    if (raw.kind === "dimension" && DIMENSION_KEYS.includes(raw.key as DimensionKey)) {
      return { kind: "dimension", key: raw.key as DimensionKey };
    }
    if (raw.kind === "measure" && MEASURE_KEYS.includes(raw.key as MeasureKey)) {
      return { kind: "measure", key: raw.key as MeasureKey };
    }
  } catch {
    /* not a pivot field */
  }
  return null;
}

/* ------------------------------ UI pieces -------------------------------- */

function FieldChip({
  field,
  label,
  title,
  tone,
  onActivate,
  onRemove,
}: {
  field: FieldRef;
  label: string;
  title?: string;
  tone: "dimension" | "count" | "indicator";
  onActivate?: () => void;
  onRemove?: () => void;
}) {
  const tones = {
    dimension: "border-sky-200 bg-sky-50 text-sky-800",
    count: "border-slate-200 bg-white text-slate-700",
    indicator: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };
  return (
    <span
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify(field));
        e.dataTransfer.effectAllowed = "move";
      }}
      title={title}
      className={`inline-flex cursor-grab items-center gap-1 rounded border px-2 py-1 text-xs font-medium active:cursor-grabbing ${tones[tone]}`}
    >
      {onActivate ? (
        <button type="button" onClick={onActivate} className="text-left">
          {label}
        </button>
      ) : (
        label
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="ml-1 text-slate-400 hover:text-red-600">
          ×
        </button>
      )}
    </span>
  );
}

function DropZone({
  zone,
  title,
  hint,
  onDropField,
  children,
}: {
  zone: Zone;
  title: string;
  hint: string;
  onDropField: (zone: Zone, field: FieldRef) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_MIME)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const field = readField(e);
        if (field) onDropField(zone, field);
      }}
      className={`min-h-[4.5rem] rounded-lg border-2 border-dashed p-2 transition-colors ${
        over ? "border-rose-400 bg-rose-50" : "border-slate-200 bg-white"
      }`}
    >
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
      <p className="mt-1 text-[11px] text-slate-400">{hint}</p>
    </div>
  );
}

const fileStem = () => `malaria-pivot-${new Date().toISOString().slice(0, 10)}`;

/* ------------------------------- Component ------------------------------- */

export default function PivotTab({ dataset }: { dataset: MisDataset }) {
  const records = useMemo(() => decodeDataset(dataset), [dataset]);
  const divisions = useMemo(() => [...new Set(records.map((r) => r.divisionName))].sort(naturalCompare), [records]);
  const yearSpan = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of records) {
      if (r.year < lo) lo = r.year;
      if (r.year > hi) hi = r.year;
    }
    return lo === Infinity ? "—" : `${lo}–${hi}`;
  }, [records]);

  const [config, setConfig] = useState<PivotConfig>(DEFAULT_CONFIG);
  const [division, setDivision] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [exporting, setExporting] = useState<"xlsx" | "pdf" | null>(null);

  const filtered = useMemo(
    () => (division ? records.filter((r) => r.divisionName === division) : records),
    [records, division],
  );
  const pivot = useMemo(() => buildPivot(filtered, config.rows, config.column), [filtered, config.rows, config.column]);
  const valueColumns = useMemo(
    () => buildValueColumns(pivot.columns, config.values, config.column !== null),
    [pivot.columns, config.values, config.column],
  );
  const totalRow = useMemo<PivotRow>(
    () => ({ key: "__grand", labels: [], cells: pivot.columnTotals, total: pivot.grandTotal }),
    [pivot],
  );
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = q ? pivot.rows.filter((r) => r.labels.some((l) => l.toLowerCase().includes(q))) : pivot.rows;
    return sortRows(visible, sort, config.rows, valueColumns);
  }, [pivot.rows, query, sort, config.rows, valueColumns]);

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
    return `Rows: ${r}  |  Columns: ${c}  |  Division: ${division || "All"}  |  Years: ${yearSpan}`;
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
      const aoa = [...(crossTab ? [header1, header2] : [header1]), ...body.map(toCells), toCells(total)];

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      if (crossTab) {
        const merges: Range[] = dimLabels.map((_, c) => ({ s: { r: 0, c }, e: { r: 1, c } }));
        let start = 0;
        valueColumns.forEach((vc, i) => {
          const next = valueColumns[i + 1];
          if (!next || next.group !== vc.group) {
            if (i > start) merges.push({ s: { r: 0, c: dimLabels.length + start }, e: { r: 0, c: dimLabels.length + i } });
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
      doc.setFontSize(13);
      doc.text("Malaria MIS - Pivot report", 28, 30);
      doc.setFontSize(8);
      doc.text(describeConfig(), 28, 44);

      autoTable(doc, {
        startY: 54,
        head: [[...dimLabels, ...valueColumns.map((vc) => (vc.group ? `${vc.group}\n${measureLabel(vc.measure)}` : measureLabel(vc.measure)))]],
        body: body.map(fmt),
        foot: [fmt(total)],
        showFoot: "lastPage",
        margin: { left: 28, right: 28 },
        styles: { fontSize: 6.5, cellPadding: 2, overflow: "linebreak" },
        headStyles: { fillColor: [30, 41, 59], halign: "center" },
        footStyles: { fillColor: [226, 232, 240], textColor: [15, 23, 42], fontStyle: "bold" },
        columnStyles: Object.fromEntries(valueColumns.map((_, i) => [dimLabels.length + i, { halign: "right" as const }])),
        horizontalPageBreak: true,
        horizontalPageBreakRepeat: dimLabels.map((_, i) => i),
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

  return (
    <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      {/* Field list */}
      <aside className="space-y-4 rounded-lg border border-slate-200 bg-white p-3">
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Dimensions</h2>
          <div className="flex flex-wrap gap-1.5">
            {DIMENSION_KEYS.map((key) => (
              <FieldChip
                key={key}
                field={{ kind: "dimension", key }}
                label={DIMENSIONS[key].label}
                tone="dimension"
                onActivate={() => dropField("rows", { kind: "dimension", key })}
              />
            ))}
          </div>
        </div>
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Indicators</h2>
          <div className="flex flex-wrap gap-1.5">
            {INDICATOR_KEYS.map((key) => (
              <FieldChip
                key={key}
                field={{ kind: "measure", key }}
                label={INDICATORS[key].label}
                title={INDICATORS[key].formula}
                tone="indicator"
                onActivate={() => dropField("values", { kind: "measure", key })}
              />
            ))}
          </div>
        </div>
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Counts</h2>
          <div className="flex flex-wrap gap-1.5">
            {NUMERIC_FIELDS.map((f) => (
              <FieldChip
                key={f.key}
                field={{ kind: "measure", key: f.key }}
                label={f.label}
                tone="count"
                onActivate={() => dropField("values", { kind: "measure", key: f.key })}
              />
            ))}
          </div>
        </div>
        <p className="text-[11px] leading-relaxed text-slate-400">
          Drag fields into Rows / Columns / Values, or click to add. API &amp; ABER need <code>upazila_population</code>.
        </p>
      </aside>

      <div className="min-w-0 space-y-3">
        {/* Zones */}
        <div className="grid gap-3 md:grid-cols-3">
          <DropZone zone="rows" title={`Rows (max ${MAX_ROW_FIELDS})`} hint="Nested left → right" onDropField={dropField}>
            {config.rows.map((key) => (
              <FieldChip
                key={key}
                field={{ kind: "dimension", key }}
                label={DIMENSIONS[key].label}
                tone="dimension"
                onRemove={() => setConfig((c) => ({ ...c, rows: c.rows.filter((d) => d !== key) }))}
              />
            ))}
          </DropZone>
          <DropZone zone="column" title="Columns" hint="One dimension for cross-tab" onDropField={dropField}>
            {config.column && (
              <FieldChip
                field={{ kind: "dimension", key: config.column }}
                label={DIMENSIONS[config.column].label}
                tone="dimension"
                onRemove={() => setConfig((c) => ({ ...c, column: null }))}
              />
            )}
          </DropZone>
          <DropZone zone="values" title="Values" hint="Counts are summed; indicators derived from sums" onDropField={dropField}>
            {config.values.map((key) => (
              <FieldChip
                key={key}
                field={{ kind: "measure", key }}
                label={isIndicator(key) ? INDICATORS[key].label : measureLabel(key)}
                tone={isIndicator(key) ? "indicator" : "count"}
                onRemove={() => setConfig((c) => ({ ...c, values: c.values.filter((v) => v !== key) }))}
              />
            ))}
          </DropZone>
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
    </div>
  );
}
