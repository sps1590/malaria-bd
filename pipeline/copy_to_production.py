#!/usr/bin/env python3
"""Copy warehouse tables prepared locally into the production (Vercel/Neon) database.

Copies population & NSP targets, derived denominators, ERA5 weather and forecasts, so production does not
have to re-download weather (free API quota) or re-import the workbook. MIS data and alerts are not copied:
production loads those itself through its daily sync.

Source: DATABASE_URL in .env.local.  Target: DATABASE_URL in .env.production.local (neither is printed).
Usage:  python pipeline/copy_to_production.py
"""
from __future__ import annotations

import re

import psycopg

import era5
import forecast
import import_quantification
from common import ROOT

TABLES = [
    "population_quantification",
    "upazila_population",
    "weather_district_monthly",
    "forecast_runs",
    "forecast_monthly",
    "forecast_backtest",
    "forecast_archive",
]


def url_from(file_name: str) -> str:
    path = ROOT / file_name
    if not path.exists():
        raise SystemExit(f"{file_name} not found in the project folder.")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r'\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$', line)
        if match:
            return match.group(1)
    raise SystemExit(f"No DATABASE_URL line in {file_name}.")


def main() -> None:
    source_url, target_url = url_from(".env.local"), url_from(".env.production.local")
    if source_url == target_url:
        raise SystemExit("Source and target are the same database — nothing to copy.")

    with psycopg.connect(source_url) as src, psycopg.connect(target_url) as dst:
        for statement in [era5.DDL, *forecast.DDL, *import_quantification.DDL]:
            dst.execute(statement)
        for table in TABLES:
            exists = src.execute("SELECT to_regclass(%s) IS NOT NULL", (table,)).fetchone()[0]
            if not exists:
                print(f"  {table:28} skipped (not in local database)")
                continue
            columns = [row[0] for row in src.execute(
                """SELECT column_name FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = %s AND is_identity = 'NO'
                   ORDER BY ordinal_position""", (table,)).fetchall()]
            column_list = ", ".join(columns)
            dst.execute(f"TRUNCATE {table}")
            with src.cursor().copy(f"COPY (SELECT {column_list} FROM {table}) TO STDOUT") as out, \
                    dst.cursor().copy(f"COPY {table} ({column_list}) FROM STDIN") as into:
                for chunk in out:
                    into.write(chunk)
            count = dst.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            print(f"  {table:28} {count:>7} rows copied")
        dst.commit()
    print("Done — production now has population, weather and forecast tables.")


if __name__ == "__main__":
    main()
