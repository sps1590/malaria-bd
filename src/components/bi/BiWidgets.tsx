"use client";

import { useState, type ReactNode } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Icon, type IconName } from "@/components/ChartTools";
import { Sparkline, heatColor } from "@/components/epi/EpiShared";
import { GRID, SERIES, axisTick, fmtInt, fmtNum } from "@/lib/chart-theme";
import { MONTHS, formatMeasure, measureLabel, percentOf, type MeasureKey, type Totals } from "@/lib/malaria-metrics";
import { MarkdownText } from "@/components/MarkdownText";
import { GOOD_WHEN_DOWN, arrow, fmtPct, type Finding, type Mover, type ParetoRow, type SignalRow } from "./calc";

const DEATH_RED = "#c81e1e";

/* ------------------------------- KPI cards ------------------------------- */

export interface KpiItem {
  key: MeasureKey;
  icon: IconName;
  value: string;
  delta: number | null;
  spark: number[];
  prevText: string | null;
  tip: string;
}

function DeltaChip({ pct, goodWhenDown }: { pct: number | null; goodWhenDown: boolean | null }) {
  if (pct === null) return <span className="text-[11px] text-slate-400">no comparison</span>;
  const flat = pct !== Infinity && Math.abs(pct) < 0.5;
  const up = pct > 0;
  const good = goodWhenDown === null || flat ? null : goodWhenDown ? !up : up;
  const color = good === null ? "text-slate-500" : good ? "text-emerald-700" : "text-rose-700";
  return <span className={`text-[11px] font-semibold tabular-nums ${color}`}>{arrow(pct)} {fmtPct(pct)}</span>;
}

export function KpiStrip({ items, active, onPick, big }: { items: KpiItem[]; active: MeasureKey; onPick: (k: MeasureKey) => void; big?: boolean }) {
  return (
    <div className={`grid h-full content-start gap-2 overflow-auto ${big ? "grid-cols-2 md:grid-cols-4" : "grid-cols-2 sm:grid-cols-4 xl:grid-cols-7"}`}>
      {items.map((it) => {
        const death = it.key === "deaths";
        const rate = it.key === "tpr" || it.key === "pfShare" || it.key === "api" || it.key === "aber";
        return (
          <button
            type="button"
            key={it.key}
            title={it.tip}
            aria-pressed={it.key === active}
            onClick={(e) => {
              e.stopPropagation();
              onPick(it.key);
            }}
            className={`flex min-w-0 flex-col justify-between rounded-lg border p-2.5 text-left transition hover:shadow ${death ? "border-red-200 bg-red-50" : rate ? "border-emerald-100 bg-emerald-50" : "border-slate-100 bg-slate-50"} ${it.key === active ? "ring-2 ring-indigo-500" : ""}`}
          >
            <div className="flex items-center gap-1.5">
              <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${death ? "bg-red-100 text-red-700" : "bg-white text-slate-600"}`}>
                <Icon name={it.icon} className="h-3.5 w-3.5" />
              </span>
              <span className={`truncate text-[10px] font-semibold uppercase tracking-wide ${death ? "text-red-700" : "text-slate-500"}`}>{measureLabel(it.key)}</span>
            </div>
            <div className="mt-1 flex items-end justify-between gap-1">
              <div className={`${big ? "text-3xl" : "text-xl"} font-bold leading-none tabular-nums ${death ? "text-red-700" : "text-slate-900"}`}>{it.value}</div>
              {it.spark.length >= 3 && <Sparkline values={it.spark} color={death ? DEATH_RED : "#2a78d6"} width={64} height={24} />}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5">
              <DeltaChip pct={it.delta} goodWhenDown={GOOD_WHEN_DOWN[it.key] ?? null} />
              {it.prevText && <span className="text-[10px] text-slate-400">{it.prevText}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------- Findings ------------------------------- */

const TONE_DOT: Record<Finding["tone"], string> = { good: "bg-emerald-500", bad: "bg-rose-500", warn: "bg-amber-500", info: "bg-sky-500" };

export function FindingsPanel({ findings }: { findings: Finding[] }) {
  return (
    <ul className="h-full space-y-2 overflow-auto pr-1">
      {findings.map((f, i) => (
        <li key={i} className="flex gap-2 text-[13px] leading-snug text-slate-700">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[f.tone]}`} aria-hidden />
          <MarkdownText text={f.text} />
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------- Signals ------------------------------- */

export function SignalsPanel({ signals, watch, latestLabel, levelWord, onPick }: { signals: SignalRow[]; watch: SignalRow[]; latestLabel: string; levelWord: string; onPick: (name: string) => void }) {
  const rows = signals.length ? signals : [];
  return (
    <div className="flex h-full flex-col gap-2 overflow-auto">
      <div className={`rounded-lg border px-3 py-2 text-xs ${signals.length ? "border-rose-200 bg-rose-50 text-rose-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
        {signals.length
          ? <><b>{signals.length}</b> {levelWord} above {signals.length === 1 ? "its" : "their"} usual range in <b>{latestLabel}</b> (index ≥ 2, ≥ 5 cases).</>
          : <>No {levelWord} is above its usual range in <b>{latestLabel}</b>.</>}
      </div>
      {rows.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-left text-[11px] text-slate-500">
            <tr><th className="py-1 font-medium">Area</th><th className="py-1 text-right font-medium">Cases</th><th className="py-1 text-right font-medium">Expected</th><th className="py-1 text-right font-medium">Index</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((s) => (
              <tr key={s.mapKey} onClick={() => onPick(s.name)} className="cursor-pointer border-t border-slate-100 hover:bg-rose-50/60">
                <td className="py-1"><div className="font-medium text-slate-800">{s.name}</div><div className="text-[10px] text-slate-400">{s.parent}</div></td>
                <td className="py-1 text-right font-semibold tabular-nums text-rose-700">{fmtInt(s.cases)}</td>
                <td className="py-1 text-right tabular-nums text-slate-500">{fmtNum(s.expected, 1)}</td>
                <td className="py-1 text-right tabular-nums"><span className={`rounded px-1.5 py-0.5 font-semibold ${s.z >= 3 ? "bg-rose-600 text-white" : "bg-rose-100 text-rose-800"}`}>{fmtNum(s.z, 1)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!signals.length && watch.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Highest index right now</p>
          <ul className="space-y-1 text-xs">
            {watch.map((s) => (
              <li key={s.mapKey} onClick={() => onPick(s.name)} className="flex cursor-pointer items-center justify-between rounded border border-slate-100 px-2 py-1 hover:bg-amber-50">
                <span><b className="text-slate-800">{s.name}</b> <span className="text-slate-400">{s.parent}</span></span>
                <span className="tabular-nums text-amber-800">{fmtInt(s.cases)} vs ~{fmtNum(s.expected, 1)} · index {fmtNum(s.z, 1)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-auto text-[10px] leading-snug text-slate-400">Each area&apos;s newest month is compared with the same month ±1 in its previous 5 years (spread floored at √mean, so quiet areas do not over-signal). Index 1–2 is normal variation; 2+ is a signal; 3+ is strong.</p>
    </div>
  );
}

/* --------------------------------- Movers -------------------------------- */

export function MoversPanel({ rises, falls, metric, prevLabel, onPick }: { rises: Mover[]; falls: Mover[]; metric: MeasureKey; prevLabel: string | null; onPick: (name: string) => void }) {
  const [side, setSide] = useState<"rises" | "falls">("rises");
  if (!prevLabel) {
    return <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">Pick a single <b>year</b> (with an earlier year in the data) to see which areas moved most against the same months of the previous year.</p>;
  }
  const rows = side === "rises" ? rises : falls;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.delta)));
  const rate = metric !== "cases" && metric !== "deaths" && metric !== "tests";
  const color = side === "rises" ? "#d03b3b" : "#2a78d6";
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-slate-500">{measureLabel(metric)} vs <b>{prevLabel}</b></p>
        <div className="flex overflow-hidden rounded-md border border-slate-200 text-[11px]">
          {(["rises", "falls"] as const).map((s) => (
            <button key={s} type="button" onClick={() => setSide(s)} className={`px-2.5 py-1 ${side === s ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
              {s === "rises" ? `▲ Biggest rises (${rises.length})` : `▼ Biggest falls (${falls.length})`}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No area {side === "rises" ? "rose" : "fell"} meaningfully{rate ? " (rates need ≥ 100 tests in both periods)" : ""}.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1.5 overflow-auto pr-1">
          {rows.map((r) => (
            <li key={r.key} onClick={() => onPick(r.label)} className="cursor-pointer rounded px-1 py-0.5 hover:bg-slate-50">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate font-medium text-slate-800">{r.label}</span>
                <span className="shrink-0 tabular-nums text-slate-500">
                  {formatMeasure(metric, r.prev)} → <b className="text-slate-800">{formatMeasure(metric, r.cur)}</b>{" "}
                  <span className={side === "rises" ? "text-rose-700" : "text-sky-700"}>({r.delta > 0 ? "+" : "−"}{formatMeasure(metric, Math.abs(r.delta))}{r.pct !== null ? `, ${fmtPct(r.pct)}` : ""})</span>
                </span>
              </div>
              <div className="mt-0.5 h-1.5 rounded bg-slate-100"><div className="h-full rounded" style={{ width: `${(Math.abs(r.delta) / max) * 100}%`, background: color }} /></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------- Concentration ---------------------------- */

export function ParetoPanel({ rows, n80, total, gini, count, label }: { rows: ParetoRow[]; n80: number; total: number; gini: number; count: number; label: string }) {
  if (!rows.length) return <p className="text-sm text-slate-500">No confirmed cases in this selection.</p>;
  const shown = rows.slice(0, 14);
  const max = shown[0].value;
  const cut = rows.findIndex((r) => r.cumulative >= 80);
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat value={String(n80)} label={`of ${count} ${label} hold 80%`} />
        <Stat value={`${Math.round(rows.slice(0, 3).reduce((s, r) => s + r.share, 0))}%`} label="held by the top 3" />
        <Stat value={fmtNum(gini, 2)} label="Gini (0 even – 1 one area)" />
      </div>
      <ul className="min-h-0 flex-1 space-y-1 overflow-auto pr-1">
        {shown.map((r, i) => (
          <li key={r.key} className={`flex items-center gap-2 text-xs ${i === cut ? "border-b-2 border-dashed border-amber-400 pb-1" : ""}`} title={`${r.label}: ${fmtInt(r.value)} cases (${r.share.toFixed(1)}%), cumulative ${r.cumulative.toFixed(0)}%`}>
            <span className="w-5 shrink-0 text-right tabular-nums text-slate-400">{i + 1}</span>
            <span className="w-28 shrink-0 truncate text-slate-700">{r.label}</span>
            <span className="h-3 min-w-0 flex-1 rounded bg-slate-100"><span className="block h-full rounded" style={{ width: `${(r.value / max) * 100}%`, background: SERIES[0] }} /></span>
            <span className="w-14 shrink-0 text-right tabular-nums text-slate-700">{fmtInt(r.value)}</span>
            <span className="w-16 shrink-0 text-right tabular-nums text-slate-400">{r.cumulative.toFixed(0)}% cum.</span>
          </li>
        ))}
      </ul>
      <p className="text-[10px] leading-snug text-slate-400">{fmtInt(total)} cases in {rows.length} of {count} {label}. The dashed line marks where the running share first passes 80%.{rows.length > shown.length ? ` Showing the top ${shown.length}.` : ""}</p>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">
      <div className="text-lg font-bold leading-tight tabular-nums text-slate-900">{value}</div>
      <div className="text-[10px] leading-tight text-slate-500">{label}</div>
    </div>
  );
}

/* --------------------------------- Calendar ------------------------------- */

export function CalendarPanel({ grid, metric, year, monthFrom, monthTo }: { grid: [number, (number | null)[]][]; metric: MeasureKey; year: number | "all"; monthFrom: number; monthTo: number }) {
  const [scale, setScale] = useState<"year" | "all">("year");
  const globalMax = Math.max(1e-9, ...grid.flatMap(([, r]) => r.map((v) => v ?? 0)));
  const labels = MONTHS.map((m) => m.slice(0, 3));
  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-slate-500">{measureLabel(metric)} by month — the seasonal pattern at a glance</p>
        <div className="flex overflow-hidden rounded-md border border-slate-200 text-[11px]" data-no-export="true">
          {(["year", "all"] as const).map((s) => (
            <button key={s} type="button" onClick={() => setScale(s)} className={`px-2 py-1 ${scale === s ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>{s === "year" ? "Within each year" : "All years"}</button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-separate border-spacing-0.5 text-[10px] tabular-nums">
          <thead className="sticky top-0 bg-white">
            <tr className="text-slate-500"><th className="px-1 text-left font-medium">Year</th>{labels.map((l, i) => <th key={l} className={`px-0.5 text-center font-medium ${i + 1 >= monthFrom && i + 1 <= monthTo ? "text-indigo-700" : ""}`}>{l}</th>)}</tr>
          </thead>
          <tbody>
            {[...grid].reverse().map(([y, row]) => {
              const max = scale === "year" ? Math.max(1e-9, ...row.map((v) => v ?? 0)) : globalMax;
              return (
                <tr key={y}>
                  <td className={`px-1 font-medium ${y === year ? "text-indigo-700" : "text-slate-700"}`}>{y}</td>
                  {row.map((v, i) => {
                    const inSel = (year === "all" || y === year) && i + 1 >= monthFrom && i + 1 <= monthTo;
                    return (
                      <td
                        key={i}
                        title={v === null ? `${labels[i]} ${y}: no data` : `${labels[i]} ${y}: ${formatMeasure(metric, v)}`}
                        style={v === null ? undefined : heatColor(Math.sqrt(v / max))}
                        className={`min-w-7 rounded px-0.5 py-0.5 text-center ${v === null ? "bg-slate-50 text-slate-300" : ""} ${inSel && year !== "all" ? "outline outline-2 outline-offset-[-1px] outline-indigo-500" : ""}`}
                      >
                        {v === null ? "·" : metric === "cases" || metric === "deaths" || metric === "tests" ? fmtInt(v) : fmtNum(v, 1)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------- Demographics ----------------------------- */

const AGE = [
  { key: "ageLt1", label: "Under 1", color: "#c6dbf5" },
  { key: "age1to4", label: "1–4", color: "#8dbbea" },
  { key: "age5to14", label: "5–14", color: "#4e92d9" },
  { key: "age15plus", label: "15 and over", color: "#1d5aa8" },
] as const;

export function DemographicsPanel({ cur, prev, prevLabel }: { cur: Totals; prev: Totals | null; prevLabel: string | null }) {
  const ageTotal = AGE.reduce((s, a) => s + cur[a.key], 0);
  const prevAge = prev ? AGE.reduce((s, a) => s + prev[a.key], 0) : 0;
  const sexTotal = cur.male + cur.female;
  if (!ageTotal && !sexTotal) return <p className="text-sm text-slate-500">No age or sex data in this selection.</p>;
  const maleShare = percentOf(cur.male, sexTotal) ?? 0;
  const prevMale = prev ? percentOf(prev.male, prev.male + prev.female) : null;
  return (
    <div className="flex h-full flex-col gap-3 overflow-auto">
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Age of confirmed cases</p>
        <div className="flex h-5 overflow-hidden rounded">
          {AGE.map((a) => <span key={a.key} title={`${a.label}: ${fmtInt(cur[a.key])}`} style={{ width: `${ageTotal ? (cur[a.key] / ageTotal) * 100 : 0}%`, background: a.color }} />)}
        </div>
        <ul className="mt-2 space-y-1 text-xs">
          {AGE.map((a) => {
            const share = percentOf(cur[a.key], ageTotal) ?? 0;
            const pshare = prevAge ? percentOf(prev![a.key], prevAge) : null;
            const d = pshare === null ? null : share - pshare;
            return (
              <li key={a.key} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: a.color }} />
                <span className="w-20 text-slate-700">{a.label}</span>
                <span className="w-14 text-right tabular-nums text-slate-800">{fmtInt(cur[a.key])}</span>
                <span className="w-12 text-right tabular-nums text-slate-500">{share.toFixed(0)}%</span>
                {d !== null && Math.abs(d) >= 0.5 && <span className="text-[10px] tabular-nums text-slate-400">{d > 0 ? "▲" : "▼"} {Math.abs(d).toFixed(1)} pts vs {prevLabel}</span>}
              </li>
            );
          })}
        </ul>
      </div>
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Sex</p>
        <div className="flex h-5 overflow-hidden rounded text-[10px] font-semibold text-white">
          <span className="flex items-center justify-center" style={{ width: `${maleShare}%`, background: SERIES[0] }}>{maleShare >= 12 ? `Male ${maleShare.toFixed(0)}%` : ""}</span>
          <span className="flex items-center justify-center" style={{ width: `${100 - maleShare}%`, background: SERIES[1] }}>{100 - maleShare >= 12 ? `Female ${(100 - maleShare).toFixed(0)}%` : ""}</span>
        </div>
        <p className="mt-1 text-xs text-slate-600">
          {fmtInt(cur.male)} male, {fmtInt(cur.female)} female ({cur.female ? fmtNum(cur.male / cur.female, 2) : "—"} males per female)
          {prevMale !== null && Math.abs(maleShare - prevMale) >= 0.5 ? `; male share ${maleShare > prevMale ? "up" : "down"} ${Math.abs(maleShare - prevMale).toFixed(1)} pts` : ""}.
        </p>
      </div>
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <b>{fmtInt(cur.pregnant)}</b> pregnant {cur.pregnant === 1 ? "woman" : "women"} with confirmed malaria{cur.female ? ` (${fmtNum(percentOf(cur.pregnant, cur.female), 1)}% of female cases)` : ""} — a priority group for prompt treatment.
      </div>
    </div>
  );
}

/* ---------------------------------- Trend --------------------------------- */

export interface TrendPoint {
  period: string;
  value: number | null;
  prior: number | null;
  avg: number | null;
  tests: number;
  tpr: number | null;
}

/** Selected measure by month with the same month a year earlier and a 3-month average, over aligned positivity / tests. */
export function TrendPanel({ data, metric }: { data: TrendPoint[]; metric: MeasureKey }) {
  const hasPrior = data.some((d) => d.prior !== null);
  const fmt = (v: unknown) => (typeof v === "number" ? formatMeasure(metric, v) : "—");
  return (
    <div className="flex h-full flex-col gap-1">
      <div className="min-h-0 flex-[3]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} syncId="bi-trend" margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="period" tick={axisTick} minTickGap={24} hide />
            <YAxis tick={axisTick} width={48} />
            <Tooltip formatter={(v) => fmt(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="value" name={measureLabel(metric)} fill={metric === "deaths" ? DEATH_RED : SERIES[0]} radius={[2, 2, 0, 0]} isAnimationActive={false} />
            {hasPrior && <Line dataKey="prior" name="Same month a year earlier" stroke="#898781" strokeDasharray="4 3" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />}
            <Line dataKey="avg" name="3-month average" stroke={SERIES[1]} strokeWidth={2.2} dot={false} connectNulls isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="min-h-0 flex-[2]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} syncId="bi-trend" margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="period" tick={axisTick} minTickGap={24} />
            <YAxis tick={axisTick} width={48} unit={metric === "tpr" ? undefined : "%"} />
            <Tooltip formatter={(v) => (typeof v === "number" ? fmtNum(v, 2) : "—")} />
            <Line dataKey={metric === "tpr" ? "tests" : "tpr"} name={metric === "tpr" ? "People tested" : "Test positivity %"} stroke={SERIES[2]} dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export const monthName = (m: number) => MONTHS[m - 1];
export type { ReactNode };
