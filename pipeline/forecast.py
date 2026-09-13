#!/usr/bin/env python3
"""Monthly malaria case and death forecasting with ERA5 climate covariates.

For Bangladesh, every division and every district with recent transmission, several models compete in
a rolling-origin backtest (the last --origins months, each forecast made only with data available at
that time). The model with the best 1-month-ahead accuracy is kept and its real measured accuracy is
stored next to the forecast — nothing is tuned to hit a target number.

Case models
  seasonal_naive   same month last year (baseline every model must beat)
  ets              damped Holt-Winters exponential smoothing on log(cases+1)
  sarima           SARIMA(1,0,1)(1,1,1)12 on log(cases+1)
  sarimax_era5     SARIMA + lagged ERA5 rainfall, temperature and humidity
  lightgbm_panel   gradient-boosted trees trained across all districts (lags, seasonality)
  lightgbm_era5    same, plus lagged ERA5 rainfall/temperature/humidity
  ensemble         mean of the two best models above

Death models (deaths are rare, so they are expected counts with Poisson intervals)
  cases_x_cfr      forecast cases x recent case-fatality ratio (shrunk towards the national ratio)
  seasonal_mean_3y mean of the same month in the previous 3 years
  mean_12m         mean of the last 12 months

Accuracy = 100 x (1 - WAPE), WAPE = sum|actual - forecast| / sum(actual) over the backtest.

Usage:  python pipeline/forecast.py [--origins 24] [--horizon 6] [--levels national,division,district]
"""
from __future__ import annotations

import argparse
import json
import time
import uuid
import warnings
from dataclasses import dataclass

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.stats import poisson
from statsmodels.tsa.holtwinters import ExponentialSmoothing
from statsmodels.tsa.statespace.sarimax import SARIMAX

from common import canonical, connect

warnings.filterwarnings("ignore")

BACKTEST_HORIZONS = (1, 3)
MIN_CASES_FOR_ACCURACY = 30
MIN_DEATHS_FOR_ACCURACY = 10
CFR_SHRINK_CASES = 1000
STAT_MODELS = ("seasonal_naive", "ets", "sarima", "sarimax_era5")
PANEL_MODELS = ("lightgbm_panel", "lightgbm_era5")

DDL = [
    """CREATE TABLE IF NOT EXISTS forecast_runs (
        run_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        level text NOT NULL, area_key text NOT NULL, area_name text NOT NULL, target text NOT NULL,
        model text NOT NULL, horizon_months smallint NOT NULL,
        accuracy_pct real, accuracy_3m_pct real, wape real, mae real, mase real,
        backtest_origins smallint NOT NULL, train_start text NOT NULL, train_end text NOT NULL,
        candidates jsonb NOT NULL, notes text NOT NULL,
        PRIMARY KEY (run_id, level, area_key, target))""",
    """CREATE TABLE IF NOT EXISTS forecast_monthly (
        level text NOT NULL, area_key text NOT NULL, area_name text NOT NULL, target text NOT NULL,
        year smallint NOT NULL, month smallint NOT NULL,
        yhat real NOT NULL, lo80 real NOT NULL, hi80 real NOT NULL, lo95 real NOT NULL, hi95 real NOT NULL,
        model text NOT NULL, run_id text NOT NULL,
        PRIMARY KEY (level, area_key, target, year, month))""",
    """CREATE TABLE IF NOT EXISTS forecast_backtest (
        level text NOT NULL, area_key text NOT NULL, target text NOT NULL,
        year smallint NOT NULL, month smallint NOT NULL, horizon smallint NOT NULL,
        actual real NOT NULL, predicted real NOT NULL, model text NOT NULL, run_id text NOT NULL,
        PRIMARY KEY (level, area_key, target, horizon, year, month))""",
    # Every forecast, keyed by the last data month it was made from. When those months are later reported,
    # the dashboard compares them with reality (live accuracy); each run re-selects the model on the newest data.
    """CREATE TABLE IF NOT EXISTS forecast_archive (
        level text NOT NULL, area_key text NOT NULL, target text NOT NULL, train_end text NOT NULL,
        year smallint NOT NULL, month smallint NOT NULL, horizon smallint NOT NULL,
        yhat real NOT NULL, lo80 real NOT NULL, hi80 real NOT NULL, model text NOT NULL, run_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (level, area_key, target, train_end, year, month))""",
]


@dataclass
class Series:
    level: str
    key: str
    name: str
    cases: pd.Series
    deaths: pd.Series
    members: set[str] | None  # canonical district keys; None = all of Bangladesh


def ym(t: int) -> tuple[int, int]:
    return t // 12, t % 12 + 1


def label(t: int) -> str:
    y, m = ym(t)
    return f"{y}-{m:02d}"


# ----------------------------------------------------------------------------- data


def load(con):
    mis = pd.DataFrame(
        con.execute("""SELECT division_name, district_name, report_year * 12 + report_month - 1,
                              sum(cases)::int, sum(deaths)::int
                       FROM mis_monthly GROUP BY 1, 2, 3""").fetchall(),
        columns=["division", "district", "t", "cases", "deaths"],
    )
    has_weather = con.execute("SELECT to_regclass('weather_district_monthly') IS NOT NULL").fetchone()[0]
    wx = pd.DataFrame(
        con.execute("""SELECT district_name, year * 12 + month - 1, precip_mm, temp_mean, rh_mean, days
                       FROM weather_district_monthly""").fetchall() if has_weather else [],
        columns=["district", "t", "precip_mm", "temp_mean", "rh_mean", "days"],
    )
    wx["dkey"] = wx["district"].map(canonical)
    return mis, wx


def build_series(mis: pd.DataFrame, levels: set[str], min_district_cases: int) -> list[Series]:
    t1 = int(mis.t.max())
    idx = pd.RangeIndex(int(mis.t.min()), t1 + 1)

    def agg(frame):
        g = frame.groupby("t")[["cases", "deaths"]].sum().reindex(idx, fill_value=0)
        return g.cases.astype(float), g.deaths.astype(float)

    out = []
    if "national" in levels:
        out.append(Series("national", "bangladesh", "Bangladesh", *agg(mis), None))
    if "division" in levels:
        for div, g in mis[mis.division != "Unassigned"].groupby("division"):
            out.append(Series("division", canonical(div), div, *agg(g), {canonical(d) for d in g.district.unique()}))
    recent = mis[mis.t > t1 - 60].groupby("district").cases.sum()
    for dist, g in mis.groupby("district"):
        if "district" not in levels or dist == "Central Reporting" or recent.get(dist, 0) < min_district_cases:
            continue
        s = Series("district", canonical(dist), dist, *agg(g), {canonical(dist)})
        s.division = g.division.iloc[0]  # type: ignore[attr-defined]
        out.append(s)
    return out


def weather_frame(wx: pd.DataFrame, members: set[str] | None, months: pd.RangeIndex) -> pd.DataFrame | None:
    sub = wx if members is None else wx[wx.dkey.isin(members)]
    sub = sub[sub.days >= 20]
    if sub.empty:
        return None
    observed = sub.groupby("t")[["precip_mm", "temp_mean", "rh_mean"]].mean()
    frame = observed.reindex(months)
    climatology = observed.groupby(observed.index % 12).mean()
    moy = pd.Series(months % 12, index=months)
    for col in frame.columns:  # months without observations (the future) get the monthly climate normal
        frame[col] = frame[col].fillna(moy.map(climatology[col]))
    return frame


def exog(frame: pd.DataFrame) -> pd.DataFrame:
    x = pd.DataFrame(index=frame.index)
    for lag in (1, 2, 3):
        x[f"precip_l{lag}"] = frame.precip_mm.shift(lag)
    x["temp_l1"] = frame.temp_mean.shift(1)
    x["temp_l2"] = frame.temp_mean.shift(2)
    x["rh_l1"] = frame.rh_mean.shift(1)
    return x


# ----------------------------------------------------------------------------- models


def fit_stat(model: str, y: pd.Series, x: pd.DataFrame | None, origin: int, h: int) -> np.ndarray | None:
    hist = y.loc[:origin].values
    try:
        if model == "seasonal_naive":
            return np.array([hist[len(hist) - 12 + (k % 12)] for k in range(h)])
        ly = np.log1p(hist)
        if model == "ets":
            fc = ExponentialSmoothing(ly, trend="add", damped_trend=True, seasonal="add", seasonal_periods=12,
                                      initialization_method="estimated").fit().forecast(h)
        elif model == "sarima":
            fc = SARIMAX(ly, order=(1, 0, 1), seasonal_order=(1, 1, 1, 12)).fit(disp=False).forecast(h)
        elif model == "sarimax_era5":
            if x is None:
                return None
            xh = x.loc[:origin]
            valid = xh.notna().all(axis=1).values
            mu, sd = xh[valid].mean(), xh[valid].std().replace(0, 1)
            xf = (x.loc[origin + 1:origin + h] - mu) / sd
            fit = SARIMAX(ly[valid], exog=((xh[valid] - mu) / sd).values, order=(1, 0, 1),
                          seasonal_order=(1, 1, 1, 12)).fit(disp=False)
            fc = fit.forecast(h, exog=xf.values)
        else:
            raise ValueError(model)
        out = np.expm1(np.asarray(fc, dtype=float))
        return None if not np.all(np.isfinite(out)) else np.clip(out, 0, None)
    except Exception:
        return None


def panel_features(df: pd.DataFrame, k: int, with_weather: bool) -> pd.DataFrame:
    y = df.y
    out = pd.DataFrame({"t": df.t, "y": y, "code": df.code, "moy": df.moy})
    for j in range(3):
        out[f"y_o{j}"] = y.shift(k + j)
    seasonal = 12 if k <= 12 else 24  # "same month last year" must already be observed at the origin
    out["y_s12"] = y.shift(seasonal)
    out["y_s24"] = y.shift(seasonal + 12)
    out["y_mean3"] = out[["y_o0", "y_o1", "y_o2"]].mean(axis=1)
    out["y_mean12"] = y.shift(k).rolling(12, min_periods=6).mean()
    if with_weather:  # only weather already observed at the forecast origin (no look-ahead)
        for j in range(3):
            out[f"precip_o{j}"] = df.precip.shift(k + j)
        out["temp_o0"] = df.temp.shift(k)
        out["rh_o0"] = df.rh.shift(k)
    return out


def panel_predict(districts: list[Series], wframes: dict, months: pd.RangeIndex, jobs: list[tuple[int, int]],
                  with_weather: bool) -> dict[tuple[int, int], dict[str, float]]:
    """jobs: (origin, horizon) pairs. Returns {(origin, k): {district_key: prediction}}."""
    frames = []
    for code, s in enumerate(districts):
        df = pd.DataFrame({"t": np.asarray(months)})
        df["code"] = code
        df["moy"] = df.t % 12
        df["y"] = np.log1p(s.cases.reindex(months)).values
        wf = wframes.get(s.key)
        for col, src in (("precip", "precip_mm"), ("temp", "temp_mean"), ("rh", "rh_mean")):
            df[col] = wf[src].reindex(months).values if wf is not None else np.nan
        frames.append(df)
    keys = [s.key for s in districts]
    results: dict[tuple[int, int], dict[str, float]] = {}
    for k in sorted({k for _, k in jobs}):
        feats = pd.concat([panel_features(f, k, with_weather) for f in frames], ignore_index=True)
        cols = [c for c in feats.columns if c not in ("t", "y")]
        for origin, kk in jobs:
            if kk != k:
                continue
            train = feats[(feats.t <= origin) & feats.y.notna() & feats.y_o0.notna()]
            test = feats[feats.t == origin + k]
            model = lgb.LGBMRegressor(n_estimators=300, learning_rate=0.05, num_leaves=31, min_child_samples=20,
                                      subsample=0.9, subsample_freq=1, colsample_bytree=0.9, random_state=7,
                                      verbose=-1)
            model.fit(train[cols], train.y, categorical_feature=["code"])
            preds = np.clip(np.expm1(model.predict(test[cols])), 0, None)
            results[(origin, k)] = {keys[int(c)]: float(p) for c, p in zip(test.code, preds)}
    return results


# ----------------------------------------------------------------------------- scoring


def score(actual: pd.Series, preds: dict[int, float], min_total: float) -> dict | None:
    ts = sorted(preds)
    if not ts:
        return None
    a = actual.loc[ts].to_numpy(float)
    p = np.clip(np.array([preds[t] for t in ts], float), 0, None)
    total = a.sum()
    wape = float(np.abs(a - p).sum() / total) if total > 0 else None
    return {
        "accuracy_pct": round(100 * (1 - wape), 1) if wape is not None and total >= min_total else None,
        "wape": wape,
        "mae": float(np.abs(a - p).mean()),
        "n": len(ts),
    }


def rank_key(metrics: dict) -> tuple:
    m1 = metrics.get(1) or {}
    acc = m1.get("accuracy_pct")
    return (acc is not None, acc if acc is not None else -m1.get("mae", 1e9))


def intervals(yhat: np.ndarray, residuals: dict[int, np.ndarray]) -> dict[str, np.ndarray]:
    out = {name: np.zeros_like(yhat) for name in ("lo80", "hi80", "lo95", "hi95")}
    for i, value in enumerate(yhat):
        k = i + 1
        base = residuals.get(1 if k <= 2 else 3)
        if base is None or len(base) < 6:
            base = next((r for r in residuals.values() if r is not None and len(r) >= 6), np.array([-0.5, 0.5]))
        scale = np.sqrt(k / 3) if k > 3 else 1.0
        centre = np.log1p(value)
        for name, q in (("lo80", 10), ("hi80", 90), ("lo95", 2.5), ("hi95", 97.5)):
            out[name][i] = max(0.0, float(np.expm1(centre + np.percentile(base, q) * scale)))
    out["lo80"] = np.minimum(out["lo80"], yhat)
    out["lo95"] = np.minimum(out["lo95"], out["lo80"])
    out["hi80"] = np.maximum(out["hi80"], yhat)
    out["hi95"] = np.maximum(out["hi95"], out["hi80"])
    return out


# ----------------------------------------------------------------------------- persistence


def save(con, run_id, s: Series, target, model, metrics, candidates, forecast, backtest, t0, t1, n_origins, notes):
    m1, m3 = metrics.get(1) or {}, metrics.get(3) or {}
    con.execute(
        """INSERT INTO forecast_runs (run_id, level, area_key, area_name, target, model, horizon_months, accuracy_pct,
               accuracy_3m_pct, wape, mae, mase, backtest_origins, train_start, train_end, candidates, notes)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (run_id, s.level, s.key, s.name, target, model, len(forecast), m1.get("accuracy_pct"), m3.get("accuracy_pct"),
         m1.get("wape"), m1.get("mae"), m1.get("mase"), n_origins, label(t0), label(t1), json.dumps(candidates), notes),
    )
    con.execute("DELETE FROM forecast_monthly WHERE level = %s AND area_key = %s AND target = %s", (s.level, s.key, target))
    con.execute("DELETE FROM forecast_backtest WHERE level = %s AND area_key = %s AND target = %s", (s.level, s.key, target))
    with con.cursor() as cur:
        cur.executemany(
            """INSERT INTO forecast_monthly (level, area_key, area_name, target, year, month, yhat, lo80, hi80, lo95, hi95, model, run_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            [(s.level, s.key, s.name, target, *ym(t), *vals, model, run_id) for t, vals in forecast],
        )
        cur.executemany(
            """INSERT INTO forecast_backtest (level, area_key, target, year, month, horizon, actual, predicted, model, run_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            [(s.level, s.key, target, *ym(t), k, a, p, model, run_id) for t, k, a, p in backtest],
        )
        cur.executemany(
            """INSERT INTO forecast_archive (level, area_key, target, train_end, year, month, horizon, yhat, lo80, hi80, model, run_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (level, area_key, target, train_end, year, month) DO UPDATE SET
                 horizon = EXCLUDED.horizon, yhat = EXCLUDED.yhat, lo80 = EXCLUDED.lo80, hi80 = EXCLUDED.hi80,
                 model = EXCLUDED.model, run_id = EXCLUDED.run_id, created_at = now()""",
            [(s.level, s.key, target, label(t1), *ym(t), t - t1, vals[0], vals[1], vals[2], model, run_id) for t, vals in forecast],
        )


# ----------------------------------------------------------------------------- main


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--origins", type=int, default=24)
    parser.add_argument("--horizon", type=int, default=18)
    parser.add_argument("--levels", default="national,division,district")
    parser.add_argument("--min-district-cases", type=int, default=50, help="cases in the last 60 months")
    args = parser.parse_args()
    started = time.time()
    run_id = uuid.uuid4().hex[:12]

    with connect() as con:
        for statement in DDL:
            con.execute(statement)
        mis, wx = load(con)
        t0, t1 = int(mis.t.min()), int(mis.t.max())
        months = pd.RangeIndex(t0, t1 + args.horizon + 1)
        all_series = build_series(mis, set(args.levels.split(",")), args.min_district_cases)
        districts = [s for s in build_series(mis, {"district"}, args.min_district_cases)]
        wframes = {s.key: weather_frame(wx, s.members, months) for s in all_series + districts}
        has_weather = any(v is not None for v in wframes.values())
        origins = list(range(t1 - args.origins, t1))
        print(f"run {run_id}: {len(all_series)} series, data {label(t0)}..{label(t1)}, "
              f"weather for {sum(v is not None for v in wframes.values())} areas", flush=True)

        # Global panel models: backtest jobs + final forecast jobs, fitted once for all areas.
        bt_jobs = [(o, k) for o in origins for k in BACKTEST_HORIZONS if o + k <= t1]
        final_jobs = [(t1, k) for k in range(1, args.horizon + 1)]
        panel = {"lightgbm_panel": panel_predict(districts, wframes, months, bt_jobs + final_jobs, with_weather=False)}
        if has_weather:
            panel["lightgbm_era5"] = panel_predict(districts, wframes, months, bt_jobs + final_jobs, with_weather=True)
        print(f"  panel models fitted ({time.time() - started:.0f}s)", flush=True)

        national_cfr = {}
        nat_c, nat_d = mis.groupby("t").cases.sum(), mis.groupby("t").deaths.sum()
        for o in list(origins) + [t1]:
            window = range(o - 35, o + 1)
            national_cfr[o] = nat_d.reindex(window, fill_value=0).sum() / max(nat_c.reindex(window, fill_value=0).sum(), 1)

        summary = []
        for s in all_series:
            x = exog(wframes[s.key]) if wframes.get(s.key) is not None else None
            members = None if s.members is None else s.members

            def panel_value(model, origin, k):
                part = panel[model].get((origin, k))
                if part is None:
                    return None
                values = [v for key, v in part.items() if members is None or key in members]
                return float(sum(values)) if values else None

            # ---- backtest: {model: {k: {target_t: prediction}}}
            bt: dict[str, dict[int, dict[int, float]]] = {}
            for model in STAT_MODELS:
                if model == "sarimax_era5" and x is None:
                    continue
                bt[model] = {k: {} for k in BACKTEST_HORIZONS}
                for o in origins:
                    pred = fit_stat(model, s.cases, x, o, max(BACKTEST_HORIZONS))
                    if pred is None:
                        continue
                    for k in BACKTEST_HORIZONS:
                        if o + k <= t1:
                            bt[model][k][o + k] = float(pred[k - 1])
            for model in panel:
                bt[model] = {k: {} for k in BACKTEST_HORIZONS}
                for o, k in bt_jobs:
                    v = panel_value(model, o, k)
                    if v is not None:
                        bt[model][k][o + k] = v

            scale = float(np.mean(np.abs(np.diff(s.cases.values, n=1)[11:]))) or 1.0
            metrics = {}
            for model, by_k in bt.items():
                if len(by_k[1]) < 0.8 * len(origins):
                    continue
                metrics[model] = {k: score(s.cases, by_k[k], MIN_CASES_FOR_ACCURACY) for k in BACKTEST_HORIZONS}
                metrics[model][1]["mase"] = metrics[model][1]["mae"] / scale
            ranked = sorted(metrics, key=lambda m: rank_key(metrics[m]), reverse=True)
            top2 = [m for m in ranked if m != "seasonal_naive"][:2]
            if len(top2) == 2:
                bt["ensemble"] = {k: {t: (bt[top2[0]][k][t] + bt[top2[1]][k][t]) / 2
                                      for t in bt[top2[0]][k] if t in bt[top2[1]][k]} for k in BACKTEST_HORIZONS}
                metrics["ensemble"] = {k: score(s.cases, bt["ensemble"][k], MIN_CASES_FOR_ACCURACY) for k in BACKTEST_HORIZONS}
                metrics["ensemble"][1]["mase"] = metrics["ensemble"][1]["mae"] / scale
                ranked = sorted(metrics, key=lambda m: rank_key(metrics[m]), reverse=True)
            best = ranked[0]

            def final(model):
                if model in panel:
                    return np.array([panel_value(model, t1, k) or 0.0 for k in range(1, args.horizon + 1)])
                if model == "ensemble":
                    return (final(top2[0]) + final(top2[1])) / 2
                return fit_stat(model, s.cases, x, t1, args.horizon)

            yhat = final(best)
            if yhat is None:
                best = "seasonal_naive"
                yhat = fit_stat(best, s.cases, x, t1, args.horizon)
            residuals = {k: np.array([np.log1p(s.cases.loc[t]) - np.log1p(p) for t, p in bt[best][k].items()])
                         for k in BACKTEST_HORIZONS}
            band = intervals(yhat, residuals)
            case_forecast = [(t1 + i + 1, (float(yhat[i]), float(band["lo80"][i]), float(band["hi80"][i]),
                                           float(band["lo95"][i]), float(band["hi95"][i]))) for i in range(args.horizon)]
            case_backtest = [(t, k, float(s.cases.loc[t]), p) for k in BACKTEST_HORIZONS for t, p in bt[best][k].items()]
            m1, m3 = metrics[best][1], metrics[best][3]
            weather_note = "with ERA5 climate covariates" if best in ("sarimax_era5", "lightgbm_era5") or (
                best == "ensemble" and any(m in ("sarimax_era5", "lightgbm_era5") for m in top2)) else "without climate covariates"
            ensemble_note = f" (mean of {top2[0]} and {top2[1]})" if best == "ensemble" else ""
            acc_text = (f"{m1['accuracy_pct']}% 1-month-ahead and {m3['accuracy_pct']}% 3-months-ahead accuracy"
                        if m1["accuracy_pct"] is not None else f"mean absolute error {m1['mae']:.1f} cases/month (too few cases for a % accuracy)")
            notes = (f"{best}{ensemble_note}, {weather_note}: {acc_text} over {m1['n']} rolling monthly backtests "
                     f"({label(min(bt[best][1]))} to {label(t1)}); accuracy = 100 x (1 - WAPE).")
            candidates = {m: {"accuracy_1m_pct": metrics[m][1]["accuracy_pct"], "accuracy_3m_pct": metrics[m][3]["accuracy_pct"],
                              "mae_1m": round(metrics[m][1]["mae"], 2)} for m in metrics}
            save(con, run_id, s, "cases", best, {1: m1, 3: m3}, candidates, case_forecast, case_backtest, t0, t1, len(origins), notes)

            # ---- deaths
            def cfr_at(o):
                window = range(o - 35, o + 1)
                c = s.cases.reindex(window, fill_value=0).sum()
                d = s.deaths.reindex(window, fill_value=0).sum()
                return (d + CFR_SHRINK_CASES * national_cfr[o]) / (c + CFR_SHRINK_CASES)

            dbt: dict[str, dict[int, dict[int, float]]] = {"cases_x_cfr": {}, "seasonal_mean_3y": {}, "mean_12m": {}}
            for k in BACKTEST_HORIZONS:
                dbt["cases_x_cfr"][k] = {t: p * cfr_at(t - k) for t, p in bt[best][k].items()}
                dbt["seasonal_mean_3y"][k] = {t: float(s.deaths.reindex([t - 12, t - 24, t - 36], fill_value=0).mean())
                                              for t in bt[best][k]}
                dbt["mean_12m"][k] = {t: float(s.deaths.reindex(range(t - k - 11, t - k + 1), fill_value=0).mean())
                                      for t in bt[best][k]}
            dmetrics = {m: {k: score(s.deaths, dbt[m][k], MIN_DEATHS_FOR_ACCURACY) for k in BACKTEST_HORIZONS} for m in dbt}
            dbest = min(dmetrics, key=lambda m: dmetrics[m][1]["mae"])
            future = [t1 + k for k in range(1, args.horizon + 1)]
            if dbest == "cases_x_cfr":
                dhat = yhat * cfr_at(t1)
            elif dbest == "seasonal_mean_3y":
                dhat = np.array([s.deaths.reindex([u for u in (t - 12 * j for j in range(1, 5)) if u <= t1][:3], fill_value=0).mean()
                                 for t in future])
            else:
                dhat = np.full(args.horizon, s.deaths.reindex(range(t1 - 11, t1 + 1), fill_value=0).mean())
            death_forecast = [(t, (float(v), float(poisson.ppf(0.10, v)), float(poisson.ppf(0.90, v)),
                                   float(poisson.ppf(0.025, v)), float(poisson.ppf(0.975, v)))) for t, v in zip(future, dhat)]
            death_backtest = [(t, k, float(s.deaths.loc[t]), p) for k in BACKTEST_HORIZONS for t, p in dbt[dbest][k].items()]
            d1, d3 = dmetrics[dbest][1], dmetrics[dbest][3]
            dacc = f"; accuracy {d1['accuracy_pct']}% (100 x (1 - WAPE))" if d1["accuracy_pct"] is not None else "; too few deaths for a % accuracy"
            dnotes = (f"{dbest}: expected deaths per month with Poisson ranges. 1-month-ahead mean absolute error "
                      f"{d1['mae']:.2f} deaths/month{dacc} over {d1['n']} rolling backtests. Deaths are rare events — "
                      "read these as expected counts, not exact predictions.")
            dcands = {m: {"mae_1m": round(dmetrics[m][1]["mae"], 3), "accuracy_1m_pct": dmetrics[m][1]["accuracy_pct"]} for m in dmetrics}
            save(con, run_id, s, "deaths", dbest, {1: d1, 3: d3}, dcands, death_forecast, death_backtest, t0, t1, len(origins), dnotes)

            summary.append((s.level, s.name, best, m1["accuracy_pct"], m3["accuracy_pct"], dbest, round(d1["mae"], 2)))
            print(f"  {s.level:9} {s.name:18} cases={best:15} acc1={m1['accuracy_pct']} acc3={m3['accuracy_pct']} "
                  f"deaths={dbest} mae={d1['mae']:.2f} ({time.time() - started:.0f}s)", flush=True)
            if s.level == "national":
                print("    candidates:", json.dumps(candidates), flush=True)

    print(f"done: run {run_id}, {len(summary)} areas in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
