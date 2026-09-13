/**
 * Chart tokens — the validated reference data-viz palette (light mode).
 * Categorical slots are assigned in fixed order to entities, never by rank.
 */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"] as const;

export const SURFACE = "#fcfcfb";
export const GRID = "#e1e0d9";
export const AXIS = "#c3c2b7";
export const INK_MUTED = "#898781";
export const INK_SECONDARY = "#52514e";

export const STATUS = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" } as const;

/** Diverging blue ↔ gray ↔ red for signed values in [-1, 1] (e.g. correlations). */
export function divergingColor(value: number | null, cap = 0.8): string {
  if (value === null) return "#f0efec";
  const t = Math.min(Math.abs(value) / cap, 1);
  const [r0, g0, b0] = [0xf0, 0xef, 0xec];
  const [r1, g1, b1] = value < 0 ? [0x2a, 0x78, 0xd6] : [0xe3, 0x49, 0x48];
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t * 0.85);
  return `rgb(${mix(r0, r1)}, ${mix(g0, g1)}, ${mix(b0, b1)})`;
}

export const axisTick = { fontSize: 11, fill: INK_MUTED };

export const fmtInt = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("en-US");

export const fmtNum = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Tooltip formatter that handles range-area values ([low, high]). */
export function tooltipValue(value: unknown): string {
  if (Array.isArray(value)) return `${fmtInt(Number(value[0]))} – ${fmtInt(Number(value[1]))}`;
  return typeof value === "number" ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(value ?? "—");
}

export const MODEL_LABEL: Record<string, string> = {
  seasonal_naive: "Seasonal naive (same month last year)",
  ets: "Exponential smoothing (damped Holt-Winters)",
  sarima: "SARIMA (seasonal ARIMA)",
  sarimax_era5: "SARIMAX + ERA5 climate covariates",
  lightgbm_panel: "LightGBM gradient boosting (all districts)",
  lightgbm_era5: "LightGBM + ERA5 climate covariates",
  ensemble: "Ensemble of the two best models",
  cases_x_cfr: "Forecast cases × case-fatality ratio",
  seasonal_mean_3y: "Same-month average of 3 years",
  mean_12m: "12-month average",
};
