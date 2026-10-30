"use client";

import "leaflet/dist/leaflet.css";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FeatureCollection } from "geojson";
import type { Map as LeafletMap, Path as LeafletPath } from "leaflet";
import { captureNodePng, downloadDataUrl } from "@/components/ChartTools";
import { GRID, SERIES, axisTick, fmtInt, fmtNum } from "@/lib/chart-theme";
import { canonicalGeoName, upazilaMatchKey } from "@/lib/malaria-metrics";
import type { Cell, CellFormat, ChartSpec, MapSpec, TableSpec } from "@/lib/analyst/types";

type Leaflet = typeof import("leaflet");

export function formatCell(v: Cell | undefined, format: CellFormat | undefined): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  switch (format) {
    case "int": return fmtInt(v);
    case "d1": return fmtNum(v, 1);
    case "d2": return fmtNum(v, 2);
    case "pct1": return `${fmtNum(v, 1)}%`;
    case "pct2": return `${fmtNum(v, 2)}%`;
    case "signed_pct": return `${v > 0 ? "▲" : v < 0 ? "▼" : ""} ${fmtNum(Math.abs(v), Math.abs(v) < 10 ? 1 : 0)}%`.trim();
    default: return Number.isInteger(v) ? fmtInt(v) : fmtNum(v, 2);
  }
}

const valueFormatter = (format: ChartSpec["format"]) => (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return format === "int" ? fmtInt(n) : format === "d1" ? fmtNum(n, 1) : format === "d2" ? fmtNum(n, 2) : format === "pct1" ? `${fmtNum(n, 1)}%` : `${fmtNum(n, 2)}%`;
};

/* ------------------------------ table ------------------------------ */

export function DataTable({ table, initialRows = 10 }: { table: TableSpec; initialRows?: number }) {
  const [all, setAll] = useState(false);
  const rows = all ? table.rows : table.rows.slice(0, initialRows);
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="max-h-96 overflow-auto">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-slate-600">
            <tr>
              {table.columns.map((c, i) => (
                <th key={c.key} className={`whitespace-nowrap border-b border-slate-200 px-3 py-2 font-semibold ${i === 0 || c.format === "text" ? "text-left" : "text-right"}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="odd:bg-white even:bg-slate-50/60">
                {table.columns.map((c, i) => {
                  const v = r[c.key];
                  const text = formatCell(v, c.format);
                  const left = i === 0 || c.format === "text";
                  const change = c.format === "signed_pct" && typeof v === "number" ? (v > 0 ? "text-rose-700" : v < 0 ? "text-emerald-700" : "") : typeof v === "string" && /^▲/.test(v) ? "text-rose-700" : typeof v === "string" && /^▼/.test(v) ? "text-emerald-700" : "";
                  return (
                    <td key={c.key} className={`whitespace-nowrap border-b border-slate-100 px-3 py-1.5 ${left ? "text-left" : "text-right tabular-nums"} ${change}`}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > initialRows && (
        <button type="button" onClick={() => setAll((a) => !a)} className="w-full border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50">
          {all ? "Show fewer rows" : `Show all ${table.rows.length} rows`}
        </button>
      )}
    </div>
  );
}

export function tableToCsv(table: TableSpec): string {
  const esc = (v: Cell | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [table.columns.map((c) => esc(c.label)).join(","), ...table.rows.map((r) => table.columns.map((c) => esc(r[c.key])).join(","))].join("\n");
}

/* ------------------------------ chart ------------------------------ */

function seriesStyle(key: string, index: number): { color: string; dash?: string; width: number; opacity: number } {
  if (key === "predicted") return { color: SERIES[1], dash: "6 4", width: 2.4, opacity: 1 };
  if (key === "lo80" || key === "hi80") return { color: SERIES[1], dash: "2 3", width: 1.2, opacity: 0.55 };
  if (key === "actual") return { color: SERIES[0], width: 2.4, opacity: 1 };
  return { color: SERIES[index % SERIES.length], width: 2.4, opacity: 1 };
}

export function DataChart({ chart }: { chart: ChartSpec }) {
  const fmt = useMemo(() => valueFormatter(chart.format), [chart.format]);
  const legend = chart.series.length > 1;
  const common = { data: chart.rows as Record<string, unknown>[], margin: { top: 8, right: 16, bottom: 0, left: 0 } };
  const yWidth = chart.format === "int" ? 52 : 56;

  if (chart.kind === "hbar") {
    const height = Math.max(200, chart.rows.length * 30 + 50);
    const longest = Math.max(...chart.rows.map((r) => String(r[chart.xKey] ?? "").length), 6);
    const labelWidth = Math.min(190, Math.max(70, longest * 6.4));
    return (
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart layout="vertical" data={chart.rows as Record<string, unknown>[]} margin={{ top: 4, right: 56, bottom: 0, left: 0 }}>
            <CartesianGrid horizontal={false} stroke={GRID} />
            <XAxis type="number" tick={axisTick} tickFormatter={(v) => fmt(v)} />
            <YAxis type="category" dataKey={chart.xKey} width={labelWidth} tick={{ ...axisTick, fill: "#52514e" }} interval={0} />
            <Tooltip formatter={(v) => fmt(v)} cursor={{ fill: "rgba(42,120,214,0.06)" }} />
            {chart.series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={seriesStyle(s.key, i).color} radius={[0, 4, 4, 0]} isAnimationActive={false} maxBarSize={20}>
                {chart.rows.length <= 14 && <LabelList dataKey={s.key} position="right" formatter={(v) => fmt(v)} style={{ fontSize: 11, fill: "#52514e" }} />}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div style={{ height: 280 }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {chart.kind === "line" ? (
          <LineChart {...common}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey={chart.xKey} tick={axisTick} interval="preserveStartEnd" minTickGap={28} />
            <YAxis tick={axisTick} width={yWidth} tickFormatter={(v) => fmt(v)} />
            <Tooltip formatter={(v) => fmt(v)} />
            {legend && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {chart.series.map((s, i) => {
              const st = seriesStyle(s.key, i);
              return <Line key={s.key} dataKey={s.key} name={s.label} stroke={st.color} strokeWidth={st.width} strokeDasharray={st.dash} strokeOpacity={st.opacity} dot={chart.rows.length <= 18 && st.opacity === 1} isAnimationActive={false} connectNulls={false} />;
            })}
          </LineChart>
        ) : (
          <BarChart {...common}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey={chart.xKey} tick={axisTick} interval={chart.rows.length > 12 ? "preserveStartEnd" : 0} minTickGap={12} />
            <YAxis tick={axisTick} width={yWidth} tickFormatter={(v) => fmt(v)} />
            <Tooltip formatter={(v) => fmt(v)} cursor={{ fill: "rgba(42,120,214,0.06)" }} />
            {legend && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {chart.series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={seriesStyle(s.key, i).color} radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={44}>
                {chart.rows.length <= 8 && chart.series.length === 1 && <LabelList dataKey={s.key} position="top" formatter={(v) => fmt(v)} style={{ fontSize: 11, fill: "#52514e" }} />}
              </Bar>
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------- map -------------------------------- */

const GEO_URL: Record<MapSpec["level"], string> = {
  division: "/geo/bd-divisions.geojson",
  district: "/geo/bd-districts.geojson",
  upazila: "/geo/bd-upazilas.geojson",
};
const NAME_PROP: Record<MapSpec["level"], string> = { division: "ADM1_EN", district: "ADM2_EN", upazila: "ADM3_EN" };
const geoCache = new Map<string, Promise<FeatureCollection>>();

function loadGeo(url: string): Promise<FeatureCollection> {
  let pending = geoCache.get(url);
  if (!pending) {
    pending = fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
      return (await res.json()) as FeatureCollection;
    });
    pending.catch(() => geoCache.delete(url));
    geoCache.set(url, pending);
  }
  return pending;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** Choropleth of the region the user asked for: boundaries from /public/geo, colours chosen by the server. */
export function AnalystMap({ map }: { map: MapSpec }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<{ unmatched: number; drawn: number; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // draw only once scrolled into view, so a long chat does not keep many Leaflet maps alive at once
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      queueMicrotask(() => setVisible(true));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let leafletMap: LeafletMap | undefined;
    let observer: ResizeObserver | undefined;
    (async () => {
      const [mod, data] = await Promise.all([import("leaflet"), loadGeo(GEO_URL[map.level])]);
      const host = hostRef.current;
      if (disposed || !host) return;
      const L = (mod as unknown as { default?: Leaflet }).default ?? (mod as Leaflet);

      const rows = new Map(map.rows.map((r) => [r.key, r]));
      const keyOf = (props: Record<string, unknown> | null | undefined) =>
        map.level === "upazila"
          ? `${canonicalGeoName(String(props?.ADM2_EN ?? ""))}|${upazilaMatchKey(String(props?.ADM3_EN ?? ""))}`
          : canonicalGeoName(String(props?.[NAME_PROP[map.level]] ?? ""));
      const allow = map.filter ? new Set(map.filter.keys) : null;
      const features = data.features.filter((f) => !allow || allow.has(canonicalGeoName(String(f.properties?.[map.filter!.prop] ?? ""))));
      if (!features.length) throw new Error("no boundaries for this region");

      const m = L.map(host, { center: [23.7, 90.35], zoom: 7, zoomSnap: 0.25, scrollWheelZoom: false, zoomAnimation: false });
      leafletMap = m;
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        opacity: 0.35,
        crossOrigin: "anonymous",
        attribution: "&copy; OpenStreetMap contributors · Boundaries: geoBoundaries",
      }).addTo(m);
      m.on("click", () => m.scrollWheelZoom.enable());
      m.on("mouseout", () => m.scrollWheelZoom.disable());

      const matched = new Set<string>();
      const layer = L.geoJSON({ type: "FeatureCollection", features } as FeatureCollection, {
        style: (feature) => ({
          color: "#57534e",
          weight: map.level === "upazila" ? 0.7 : 1,
          fillOpacity: 0.88,
          fillColor: rows.get(keyOf(feature?.properties))?.color ?? map.noData,
        }),
        onEachFeature: (feature, lyr) => {
          const key = keyOf(feature.properties);
          const row = rows.get(key);
          if (row) matched.add(key);
          const fallback = String(feature.properties?.[NAME_PROP[map.level]] ?? "");
          lyr.bindTooltip(`<strong>${escapeHtml(row?.name ?? fallback)}</strong><br/>${escapeHtml(row?.tip ?? "No reports in this period")}`, { sticky: true });
          lyr.on({
            mouseover: (e) => (e.target as LeafletPath).setStyle({ weight: 2.5, color: "#0f172a" }),
            mouseout: (e) => layer.resetStyle(e.target as LeafletPath),
          });
        },
      }).addTo(m);

      const bounds = layer.getBounds();
      m.invalidateSize();
      m.fitBounds(bounds, { padding: [12, 12], maxZoom: 11 });
      observer = new ResizeObserver(() => {
        m.invalidateSize();
        m.fitBounds(bounds, { padding: [12, 12], maxZoom: 11 });
      });
      observer.observe(host);
      setInfo({ drawn: features.length, unmatched: map.rows.filter((r) => !matched.has(r.key)).length });
    })().catch((err: unknown) => {
      if (!disposed) setInfo({ drawn: 0, unmatched: 0, error: err instanceof Error ? err.message : String(err) });
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      leafletMap?.remove();
    };
  }, [map, visible]);

  const savePng = async () => {
    if (!frameRef.current || saving) return;
    setSaving(true);
    try {
      downloadDataUrl(await captureNodePng(frameRef.current), `map-${map.metricLabel}-${map.level}`);
    } catch {
      /* the tile layer may block capture offline; the table download still works */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-700">{map.title}</p>
        <button type="button" onClick={() => void savePng()} disabled={saving || !!info?.error} className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
          {saving ? "Saving…" : "Download PNG"}
        </button>
      </div>
      <div ref={frameRef} className="relative isolate h-[420px] w-full overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div ref={hostRef} className="h-full w-full bg-slate-50" />
        <div className="pointer-events-none absolute bottom-2 left-2 z-[1000] rounded bg-white/90 p-2 text-[11px] shadow">
          <div className="mb-1 font-semibold text-slate-700">{map.metricLabel}</div>
          {[...map.legend, { color: map.noData, label: "No data" }].map((item) => (
            <div key={item.label + item.color} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-4 rounded-sm border border-slate-300" style={{ background: item.color }} />
              {item.label}
            </div>
          ))}
        </div>
        {!info && <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-white/60 text-xs text-slate-500">Drawing map…</div>}
        {info?.error && (
          <div className="absolute inset-x-2 top-2 z-[1000] rounded bg-amber-50 p-2 text-xs text-amber-800 shadow">Map could not be drawn ({info.error}). The table has the same figures.</div>
        )}
      </div>
      {info && !info.error && info.unmatched > 0 && (
        <p className="text-[11px] text-slate-500">{info.unmatched} reporting {info.unmatched === 1 ? "unit has" : "units have"} no boundary on the map (hospital/central units) — see the table.</p>
      )}
    </div>
  );
}
