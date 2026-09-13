#!/usr/bin/env python3
"""ERA5 reanalysis weather per district -> weather_district_monthly.

Source: ECMWF Copernicus ERA5 (hourly 0.25° reanalysis), served as daily aggregates by the
Open-Meteo historical archive API (no account needed). One representative point per district.

The first run backfills from --start for all 64 districts; later runs refresh only recent months
(ERA5 is finalised ~5 days behind real time). Safe to interrupt and re-run.

Usage:  python pipeline/era5.py [--start 2012-01-01] [--refresh-days 75] [--only Bandarban,Rangamati]
"""
from __future__ import annotations

import argparse
import datetime as dt
import time

import pandas as pd
import requests

from common import canonical, connect, district_points


class QuotaExhausted(RuntimeError):
    """The free Open-Meteo quota is used up; already-loaded districts are kept."""

API_URL = "https://archive-api.open-meteo.com/v1/archive"
SOURCE = "ERA5 reanalysis (ECMWF Copernicus) via Open-Meteo"
DAILY_VARS = [
    "temperature_2m_mean",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_sum",
    "relative_humidity_2m_mean",
    "dew_point_2m_mean",
    "soil_moisture_0_to_7cm_mean",
    "wind_speed_10m_mean",
    "et0_fao_evapotranspiration",
]

DDL = """
CREATE TABLE IF NOT EXISTS weather_district_monthly (
    district_name   text     NOT NULL,
    division_name   text     NOT NULL,
    year            smallint NOT NULL,
    month           smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
    lat             real     NOT NULL,
    lon             real     NOT NULL,
    temp_mean       real,
    temp_max        real,
    temp_min        real,
    precip_mm       real,
    rainy_days      smallint,
    heavy_rain_days smallint,
    rh_mean         real,
    dewpoint_mean   real,
    soil_moisture   real,
    wind_mean       real,
    et0_mm          real,
    days            smallint NOT NULL,
    source          text     NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (district_name, year, month)
)
"""

COLUMNS = [
    "district_name", "division_name", "year", "month", "lat", "lon", "temp_mean", "temp_max", "temp_min",
    "precip_mm", "rainy_days", "heavy_rain_days", "rh_mean", "dewpoint_mean", "soil_moisture", "wind_mean",
    "et0_mm", "days", "source",
]
UPSERT = f"""
INSERT INTO weather_district_monthly ({", ".join(COLUMNS)})
VALUES ({", ".join(["%s"] * len(COLUMNS))})
ON CONFLICT (district_name, year, month) DO UPDATE SET
    {", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS[4:])}, updated_at = now()
"""


def fetch_daily(lat: float, lon: float, start: dt.date, end: dt.date, attempts: int = 10) -> pd.DataFrame:
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "daily": ",".join(DAILY_VARS),
        "models": "era5",
        "timezone": "Asia/Dhaka",
    }
    for attempt in range(1, attempts + 1):
        try:
            res = requests.get(API_URL, params=params, timeout=180)
        except requests.RequestException as err:
            wait = min(30 * attempt, 300)
            print(f"    network error ({err}); retry in {wait}s", flush=True)
            time.sleep(wait)
            continue
        if res.status_code == 429 or res.status_code >= 500:
            # Hourly/daily free-tier windows: back off up to 30 minutes between tries.
            wait = min(120 * attempt, 1800) if res.status_code == 429 else min(30 * attempt, 300)
            print(f"    HTTP {res.status_code} (rate limit/server); retry in {wait}s", flush=True)
            time.sleep(wait)
            continue
        res.raise_for_status()
        frame = pd.DataFrame(res.json()["daily"])
        frame["time"] = pd.to_datetime(frame["time"])
        return frame
    raise QuotaExhausted(f"Open-Meteo still refusing requests after {attempts} attempts")


def to_monthly(daily: pd.DataFrame) -> pd.DataFrame:
    daily = daily.dropna(subset=["temperature_2m_mean"])
    keys = [daily["time"].dt.year.rename("year"), daily["time"].dt.month.rename("month")]
    g = daily.groupby(keys)
    rain = daily["precipitation_sum"]
    return pd.DataFrame({
        "temp_mean": g["temperature_2m_mean"].mean(),
        "temp_max": g["temperature_2m_max"].mean(),
        "temp_min": g["temperature_2m_min"].mean(),
        "precip_mm": g["precipitation_sum"].sum(),
        "rainy_days": (rain >= 1).groupby(keys).sum(),
        "heavy_rain_days": (rain >= 20).groupby(keys).sum(),
        "rh_mean": g["relative_humidity_2m_mean"].mean(),
        "dewpoint_mean": g["dew_point_2m_mean"].mean(),
        "soil_moisture": g["soil_moisture_0_to_7cm_mean"].mean(),
        "wind_mean": g["wind_speed_10m_mean"].mean(),
        "et0_mm": g["et0_fao_evapotranspiration"].sum(),
        "days": g.size(),
    }).reset_index()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--start", default="2012-01-01", type=dt.date.fromisoformat)
    parser.add_argument("--refresh-days", default=75, type=int)
    parser.add_argument("--only", default="", help="comma-separated district names (boundary spelling)")
    args = parser.parse_args()

    end = dt.date.today() - dt.timedelta(days=6)
    only = {name.strip().lower() for name in args.only.split(",") if name.strip()}
    points = [p for p in district_points() if not only or p["district_name"].lower() in only]

    with connect() as con:
        con.execute(DDL)
        # Malaria-burden districts first, so forecasts get climate covariates before the free daily quota runs out.
        if con.execute("SELECT to_regclass('mis_monthly') IS NOT NULL").fetchone()[0]:
            burden = {canonical(name): float(cases or 0) for name, cases in con.execute(
                "SELECT district_name, sum(cases) FROM mis_monthly "
                "WHERE report_year >= extract(year FROM now())::int - 5 GROUP BY 1").fetchall()}
            points.sort(key=lambda p: -burden.get(canonical(p["district_name"]), 0.0))
        for n, point in enumerate(points, 1):
            last = con.execute(
                "SELECT max(make_date(year, month, 1)) FROM weather_district_monthly WHERE district_name = %s",
                (point["district_name"],),
            ).fetchone()[0]
            if last is None:
                start = args.start
            else:
                refresh_from = (end - dt.timedelta(days=args.refresh_days)).replace(day=1)
                start = max(args.start, min(last, refresh_from))
            if start > end:
                continue

            t0 = time.time()
            try:
                daily = fetch_daily(point["lat"], point["lon"], start, end)
            except QuotaExhausted as err:
                print(f"Stopping: {err}. {n - 1} districts processed this run; re-run later to continue.", flush=True)
                break
            monthly = to_monthly(daily)
            rows = [
                (point["district_name"], point["division_name"], int(r.year), int(r.month), point["lat"], point["lon"],
                 *(None if pd.isna(v) else float(v) for v in (
                     r.temp_mean, r.temp_max, r.temp_min, r.precip_mm)),
                 int(r.rainy_days), int(r.heavy_rain_days),
                 *(None if pd.isna(v) else float(v) for v in (
                     r.rh_mean, r.dewpoint_mean, r.soil_moisture, r.wind_mean, r.et0_mm)),
                 int(r.days), SOURCE)
                for r in monthly.itertuples(index=False)
            ]
            with con.cursor() as cur:
                cur.executemany(UPSERT, rows)
            print(f"[{n}/{len(points)}] {point['district_name']}: {start} -> {end}, {len(rows)} months "
                  f"({time.time() - t0:.1f}s)", flush=True)
            time.sleep(1.0)  # stay well inside the free API's per-minute limit


if __name__ == "__main__":
    main()
