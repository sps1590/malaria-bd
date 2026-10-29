"use client";

import type { ReactElement, ReactNode } from "react";
import { ResponsiveContainer } from "recharts";
import { Icon, PopoutCard } from "@/components/ChartTools";
import { fmtNum } from "@/lib/chart-theme";

/** Anchor-able section with a heading band, so a long page reads as a report. */
export function Section({ id, title, subtitle, children }: { id: string; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-14 space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 border-b-2 border-indigo-200 pb-1">
        <h2 className="text-base font-bold tracking-tight text-slate-900">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

/** Standard chart card: pop-out/PNG header, explanatory note, fixed-height responsive chart body. */
export function ChartPanel({
  title,
  note,
  height = 288,
  actions,
  className,
  children,
}: {
  title: string;
  note?: ReactNode;
  height?: number;
  actions?: ReactNode;
  className?: string;
  children: ReactElement;
}) {
  return (
    <PopoutCard title={title} className={className} actions={actions} headerExtra={note && <p className="text-xs text-slate-500">{note}</p>}>
      {(big) => (
        <div style={{ height: big ? undefined : height }} className={big ? "h-[65vh]" : ""}>
          <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
        </div>
      )}
    </PopoutCard>
  );
}

/** Percent change with arrow; for malaria a fall is good news, so down = green by default. */
export function Delta({ pct, goodWhenDown = true, className = "" }: { pct: number | null; goodWhenDown?: boolean; className?: string }) {
  if (pct === null) return <span className={`text-slate-400 ${className}`}>new</span>;
  const down = pct < 0;
  const good = goodWhenDown ? down : !down;
  const flat = Math.abs(pct) < 0.5;
  return (
    <span className={`font-semibold tabular-nums ${flat ? "text-slate-500" : good ? "text-emerald-700" : "text-rose-700"} ${className}`}>
      {flat ? "≈" : down ? "▼" : "▲"} {fmtNum(Math.abs(pct), Math.abs(pct) < 10 ? 1 : 0)}%
    </span>
  );
}

/** Tiny dependency-free sparkline (oldest → newest), filled under the line. */
export function Sparkline({ values, color = "#2a78d6", width = 96, height = 28 }: { values: number[]; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="shrink-0" aria-hidden>
      <polygon points={`0,${height} ${pts.join(" ")} ${width},${height}`} fill={color} opacity={0.14} />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={(values.length - 1) * step} cy={height - 2 - (values[values.length - 1] / max) * (height - 4)} r={2.2} fill={color} />
    </svg>
  );
}

/** KPI tile: big value, comparison line, optional sparkline. */
export function Kpi({
  label,
  value,
  sub,
  delta,
  spark,
  sparkColor,
  tone = "neutral",
  title,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  delta?: ReactNode;
  spark?: number[];
  sparkColor?: string;
  tone?: "neutral" | "danger";
  title?: string;
}) {
  const danger = tone === "danger";
  return (
    <div title={title} className={`flex flex-col justify-between rounded-xl border p-3 ${danger ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"}`}>
      <div className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${danger ? "text-red-700" : "text-slate-500"}`}>
        {danger && <Icon name="deaths" className="h-3.5 w-3.5" />}
        {label}
      </div>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
        <div className={`text-2xl font-bold leading-none tabular-nums ${danger ? "text-red-700" : "text-slate-900"}`}>{value}</div>
        {spark && <Sparkline values={spark} color={sparkColor ?? (danger ? "#d03b3b" : "#2a78d6")} />}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
        {delta}
        {sub}
      </div>
    </div>
  );
}

/** Light → dark single-hue ramp (reference blue) for heat cells; t in [0, 1]. */
export function heatColor(t: number): { background: string; color: string } {
  const c = Math.max(0, Math.min(1, t));
  const from = [239, 245, 253];
  const to = [22, 74, 140];
  const mix = from.map((f, i) => Math.round(f + (to[i] - f) * c));
  return { background: `rgb(${mix.join(",")})`, color: c > 0.52 ? "#ffffff" : "#1e293b" };
}

export function Note({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <p className={`rounded-lg border px-3 py-2 text-xs ${tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-600"}`}>{children}</p>
  );
}
