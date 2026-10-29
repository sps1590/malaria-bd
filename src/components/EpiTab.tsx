"use client";

import { useMemo, useState } from "react";
import EpiClinical from "@/components/epi/EpiClinical";
import EpiMethods from "@/components/epi/EpiMethods";
import EpiPeople from "@/components/epi/EpiPeople";
import EpiPlace from "@/components/epi/EpiPlace";
import EpiSummary from "@/components/epi/EpiSummary";
import EpiTime from "@/components/epi/EpiTime";
import type { EpiModel } from "@/components/epi/model";
import { areaRows, endemicChannel, monthlySeries, periodLabel, recT, seasonality, windowTotals, yearlyRows } from "@/lib/epi-calc";
import { UNASSIGNED_DIVISION, canonicalGeoName, decodeDataset, isEndemicDistrictKey, type MisDataset, type MisRecord } from "@/lib/malaria-metrics";

const SECTIONS = [
  { id: "epi-summary", label: "Summary" },
  { id: "epi-time", label: "Time" },
  { id: "epi-place", label: "Place" },
  { id: "epi-people", label: "People" },
  { id: "epi-clinical", label: "Clinical" },
  { id: "epi-surveillance", label: "Surveillance" },
  { id: "epi-methods", label: "Methods" },
];

/**
 * Epidemiology tab — a malaria situation-analysis report built from the loaded MIS records: key findings,
 * time (trend, endemic channel, outbreak signals, seasonality), place (league table, concentration, strata,
 * elimination status), people (species, age, sex), clinical outcomes and surveillance quality.
 */
export default function EpiTab({ dataset }: { dataset: MisDataset }) {
  const records = useMemo(() => decodeDataset(dataset), [dataset]);
  const [division, setDivision] = useState("");
  const [district, setDistrict] = useState("");
  const [endemicOnly, setEndemicOnly] = useState(false);

  const divisions = useMemo(() => [...new Set(records.map((r) => r.divisionName))].filter((d) => d !== UNASSIGNED_DIVISION).sort(), [records]);
  const districts = useMemo(() => {
    const names = new Set<string>();
    for (const r of records) {
      if (division && r.divisionName !== division) continue;
      if (endemicOnly && !isEndemicDistrictKey(canonicalGeoName(r.districtName))) continue;
      names.add(r.districtName);
    }
    return [...names].sort();
  }, [records, division, endemicOnly]);

  const scoped = useMemo<MisRecord[]>(
    () =>
      records.filter(
        (r) =>
          (!division || r.divisionName === division) &&
          (!district || r.districtName === district) &&
          (!endemicOnly || isEndemicDistrictKey(canonicalGeoName(r.districtName))),
      ),
    [records, division, district, endemicOnly],
  );

  const scopeLabel = district || [division, endemicOnly ? "endemic districts" : ""].filter(Boolean).join(" · ") || "Bangladesh";
  const model = useMemo<EpiModel>(() => {
    // "Now" is the newest month in the whole dataset, so every scope is judged on the same calendar.
    const latest = records.reduce((p, r) => Math.max(p, recT(r)), 0);
    const series = monthlySeries(scoped, latest);
    const upazilaRows = areaRows(scoped, "upazila", latest);
    const years = records.map((r) => r.year);
    return {
      scoped,
      scopeLabel: endemicOnly && !division && !district ? "Endemic districts (13)" : scopeLabel,
      latest,
      latestLabel: periodLabel(latest),
      last12Label: `${periodLabel(latest - 11)} – ${periodLabel(latest)}`,
      series,
      yearly: yearlyRows(scoped),
      last12: windowTotals(scoped, latest, 0, 12),
      prev12: windowTotals(scoped, latest, 12, 24),
      districtRows: areaRows(scoped, "district", latest),
      upazilaRows,
      reportingUpazilas: upazilaRows.filter((u) => u.last12.rows > 0),
      endemic: endemicChannel(series, latest),
      seasonal: seasonality(series, latest),
      populationSource: dataset.populationSource,
      firstYear: years.length ? Math.min(...years) : 0,
      lastYear: years.length ? Math.max(...years) : 0,
    };
  }, [records, scoped, scopeLabel, endemicOnly, division, district, dataset.populationSource]);

  const placeLevel = district ? "upazila" : "district";
  const earliest = dataset.years[0];
  const short = model.firstYear > (earliest ?? model.firstYear);

  return (
    <div className="space-y-6">
      <div className="z-30 -mx-1 sm:sticky sm:top-0 space-y-2 rounded-xl border border-slate-200 bg-white/95 p-2.5 text-sm shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <select value={division} onChange={(e) => { setDivision(e.target.value); setDistrict(""); }} className="rounded border border-slate-300 px-2 py-1.5" aria-label="Division">
            <option value="">All divisions</option>
            {divisions.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={district} onChange={(e) => setDistrict(e.target.value)} className="max-w-44 rounded border border-slate-300 px-2 py-1.5" aria-label="District">
            <option value="">All districts</option>
            {districts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <label className="flex cursor-pointer items-center gap-1.5 rounded border border-slate-300 px-2 py-1.5 text-xs text-slate-700" title="Bandarban, Rangamati, Khagrachhari, Cox's Bazar, Chattogram, Sylhet, Sunamganj, Habiganj, Moulvibazar, Mymensingh, Sherpur, Netrokona, Kurigram">
            <input type="checkbox" checked={endemicOnly} onChange={(e) => { setEndemicOnly(e.target.checked); setDistrict(""); }} />
            Endemic districts (13)
          </label>
          <span className="text-xs text-slate-500">
            Scope: <b>{model.scopeLabel}</b> · data {model.firstYear}–{model.lastYear}, latest month <b>{model.latestLabel}</b>
          </span>
          <nav className="ml-auto flex flex-wrap gap-1" aria-label="Sections">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700">
                {s.label}
              </a>
            ))}
          </nav>
        </div>
        {short && (
          <p className="text-[11px] text-amber-700">
            Showing {model.firstYear}–{model.lastYear} only. Long-term trends, the endemic channel and signal detection are richer with the full history — set “From” to {earliest} in the header.
          </p>
        )}
      </div>

      <div id="epi-summary" className="scroll-mt-14 space-y-3">
        <EpiSummary m={model} />
      </div>
      <EpiTime m={model} />
      <EpiPlace m={model} level={placeLevel} />
      <EpiPeople m={model} />
      <EpiClinical m={model} />
      <EpiMethods m={model} />
    </div>
  );
}

export type { MisRecord };
