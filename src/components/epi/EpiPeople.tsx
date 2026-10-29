"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { GRID, SERIES, SURFACE, axisTick, fmtInt, fmtNum, tooltipValue } from "@/lib/chart-theme";
import { percentOf } from "@/lib/malaria-metrics";
import { ChartPanel, Kpi, Section } from "./EpiShared";
import type { EpiModel } from "./model";

const SHARE_TICKS = [0, 25, 50, 75, 100];
const AGE_COLORS = ["#c6dbf5", "#8dbbea", "#4e92d9", "#1d5aa8"]; // ordered groups → one-hue ramp, youngest lightest

export default function EpiPeople({ m }: { m: EpiModel }) {
  const [speciesMode, setSpeciesMode] = useState<"count" | "share">("share");
  const [ageMode, setAgeMode] = useState<"share" | "count">("share");

  const species = useMemo(
    () =>
      m.yearly.map((y) => {
        const t = y.totals;
        const sum = t.pf + t.pv + t.mixed;
        return {
          year: String(y.year),
          pf: speciesMode === "share" ? round1(percentOf(t.pf, sum)) : t.pf,
          pv: speciesMode === "share" ? round1(percentOf(t.pv, sum)) : t.pv,
          mixed: speciesMode === "share" ? round1(percentOf(t.mixed, sum)) : t.mixed,
        };
      }),
    [m.yearly, speciesMode],
  );

  const ages = useMemo(
    () =>
      m.yearly.map((y) => {
        const t = y.totals;
        const sum = t.ageLt1 + t.age1to4 + t.age5to14 + t.age15plus;
        const v = (n: number) => (ageMode === "share" ? round1(percentOf(n, sum)) : n);
        return { year: String(y.year), u1: v(t.ageLt1), a14: v(t.age1to4), a514: v(t.age5to14), a15: v(t.age15plus) };
      }),
    [m.yearly, ageMode],
  );

  const sex = useMemo(
    () =>
      m.yearly.map((y) => {
        const t = y.totals;
        return { year: String(y.year), male: round1(percentOf(t.male, t.male + t.female)), pregnant: t.pregnant, pregPer100: round1(percentOf(t.pregnant, t.female)) };
      }),
    [m.yearly],
  );

  const a = m.last12;
  const ageSum = a.ageLt1 + a.age1to4 + a.age5to14 + a.age15plus;
  const sexSum = a.male + a.female;
  const modeToggle = (value: string, set: (v: "share" | "count") => void) => (
    <div className="flex overflow-hidden rounded-md border border-slate-200 text-[11px]" data-no-export="true">
      {(["share", "count"] as const).map((s) => (
        <button key={s} type="button" onClick={() => set(s)} className={`px-2 py-1 ${value === s ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
          {s === "share" ? "% share" : "Counts"}
        </button>
      ))}
    </div>
  );

  return (
    <Section id="epi-people" title="People · who is affected" subtitle="Parasite species, age and sex profile of confirmed cases — the basis for targeting interventions.">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Children under 15" value={`${fmtNum(percentOf(a.ageLt1 + a.age1to4 + a.age5to14, ageSum), 0)}%`} sub={`of cases, ${m.last12Label}`} />
        <Kpi label="Adults 15+" value={`${fmtNum(percentOf(a.age15plus, ageSum), 0)}%`} sub={`${fmtInt(a.age15plus)} cases — forest/occupational exposure`} />
        <Kpi label="Male share" value={`${fmtNum(percentOf(a.male, sexSum), 0)}%`} sub={`${fmtNum(a.female ? a.male / a.female : null, 2)} males per female`} />
        <Kpi label="Pregnant women" value={fmtInt(a.pregnant)} sub={`${fmtNum(percentOf(a.pregnant, a.female), 1)}% of female cases`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartPanel
          title="Parasite species by year"
          note="P. falciparum drives severe disease and most deaths; P. vivax relapses from dormant liver stages, so it needs radical cure (primaquine / tafenoquine) and gains share as falciparum is controlled."
          actions={modeToggle(speciesMode, (v) => setSpeciesMode(v))}
        >
          <BarChart data={species} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="year" tick={axisTick} />
            <YAxis tick={axisTick} width={48} tickFormatter={speciesMode === "share" ? (v: number) => `${v}%` : undefined} domain={speciesMode === "share" ? [0, 100] : undefined} ticks={speciesMode === "share" ? SHARE_TICKS : undefined} />
            <Tooltip formatter={speciesMode === "share" ? (v) => `${v}%` : tooltipValue} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="pf" name="P. falciparum" stackId="s" fill={SERIES[0]} stroke={SURFACE} strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="pv" name="P. vivax" stackId="s" fill={SERIES[1]} stroke={SURFACE} strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="mixed" name="Mixed (Pf+Pv)" stackId="s" fill={SERIES[2]} stroke={SURFACE} strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ChartPanel>

        <ChartPanel
          title="Age profile of cases by year"
          note="Reported age bands. A rising adult share points to occupational or forest-fringe exposure rather than household transmission to children."
          actions={modeToggle(ageMode, (v) => setAgeMode(v))}
        >
          <BarChart data={ages} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="year" tick={axisTick} />
            <YAxis tick={axisTick} width={48} tickFormatter={ageMode === "share" ? (v: number) => `${v}%` : undefined} domain={ageMode === "share" ? [0, 100] : undefined} ticks={ageMode === "share" ? SHARE_TICKS : undefined} />
            <Tooltip formatter={ageMode === "share" ? (v) => `${v}%` : tooltipValue} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="u1" name="Under 1" stackId="a" fill={AGE_COLORS[0]} stroke={SURFACE} strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="a14" name="1–4" stackId="a" fill={AGE_COLORS[1]} stroke={SURFACE} strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="a514" name="5–14" stackId="a" fill={AGE_COLORS[2]} stroke={SURFACE} strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="a15" name="15 and over" stackId="a" fill={AGE_COLORS[3]} stroke={SURFACE} strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ChartPanel>

        <ChartPanel title="Sex ratio — male share of cases" note="Above 50% means men carry more of the burden (typically outdoor work, forest entry, migration).">
          <LineChart data={sex} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="year" tick={axisTick} />
            <YAxis tick={axisTick} width={48} domain={[30, 80]} tickFormatter={(v: number) => `${v}%`} />
            <Tooltip formatter={(v) => `${v}%`} />
            <ReferenceLine y={50} stroke="#898781" strokeDasharray="4 3" label={{ value: "parity", fontSize: 10, fill: "#898781", position: "insideBottomRight" }} />
            <Line dataKey="male" name="Male share of cases" stroke={SERIES[0]} strokeWidth={2.4} dot={{ r: 3, stroke: SURFACE, strokeWidth: 1 }} isAnimationActive={false} />
          </LineChart>
        </ChartPanel>

        <ChartPanel title="Malaria in pregnancy" note="Pregnant women with confirmed malaria (a priority group: anaemia, low birth weight, severe disease). Tooltip shows them per 100 female cases.">
          <BarChart data={sex} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="year" tick={axisTick} />
            <YAxis tick={axisTick} width={40} allowDecimals={false} />
            <Tooltip formatter={(v, _n, item) => [`${fmtInt(Number(v))} (${(item?.payload as { pregPer100?: number })?.pregPer100 ?? "—"} per 100 female cases)`, "Pregnant women"]} />
            <Bar dataKey="pregnant" name="Pregnant women" fill={SERIES[4]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ChartPanel>
      </div>
    </Section>
  );
}

const round1 = (v: number | null) => (v === null ? 0 : Math.round(v * 10) / 10);
