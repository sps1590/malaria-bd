import type { AreaRow, EndemicChannel, MonthPoint, Seasonality, YearRow } from "@/lib/epi-calc";
import type { MisRecord, Totals } from "@/lib/malaria-metrics";

/** Everything the Epidemiology sections share, computed once per scope in EpiTab. */
export interface EpiModel {
  /** Records inside the chosen geography (all loaded years). */
  scoped: MisRecord[];
  scopeLabel: string;
  /** Month index of the newest month in the data. */
  latest: number;
  latestLabel: string;
  /** "Oct 2025 – Sep 2026" */
  last12Label: string;
  series: MonthPoint[];
  yearly: YearRow[];
  last12: Totals;
  prev12: Totals;
  districtRows: AreaRow[];
  upazilaRows: AreaRow[];
  /** Upazilas that submitted at least one report in the last 12 months (the denominator for status and concentration). */
  reportingUpazilas: AreaRow[];
  endemic: EndemicChannel;
  seasonal: Seasonality;
  populationSource: string | null | undefined;
  /** Years loaded in the browser (header range). */
  firstYear: number;
  lastYear: number;
}
