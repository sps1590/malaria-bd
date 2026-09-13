"""Shared helpers for the Python data pipeline (weather ingest, forecasting)."""
from __future__ import annotations

import json
import os
import re
import unicodedata
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[1]
_ALIASES = json.loads((ROOT / "src" / "lib" / "geo-aliases.json").read_text(encoding="utf-8"))


def database_url() -> str:
    """DATABASE_URL from the environment, falling back to .env.local for local runs."""
    url = os.environ.get("DATABASE_URL")
    env_file = ROOT / ".env.local"
    if not url and env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            match = re.match(r'\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$', line)
            if match:
                url = match.group(1)
    if not url:
        raise SystemExit("DATABASE_URL is not set (environment or .env.local)")
    return url


def connect() -> psycopg.Connection:
    return psycopg.connect(database_url(), autocommit=True)


def canonical(name: str) -> str:
    """Python twin of canonicalGeoName() in src/lib/malaria-metrics.ts."""
    base = unicodedata.normalize("NFKD", name).lower()
    base = re.sub(r"\b(division|district|zila|zilla|upazila|upazilla|thana)\b", "", base)
    base = re.sub(r"[^a-z]", "", base)
    return _ALIASES["names"].get(base, base)


def _polygons(geometry: dict) -> list:
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"]
    return []


def _ring_area_centroid(ring: list) -> tuple[float, float, float]:
    area = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        cross = x0 * y1 - x1 * y0
        area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    area /= 2
    if abs(area) < 1e-12:
        xs, ys = zip(*ring)
        return 0.0, sum(xs) / len(xs), sum(ys) / len(ys)
    return abs(area), cx / (6 * area), cy / (6 * area)


def district_points() -> list[dict]:
    """One representative point (centroid of the largest polygon) per district boundary."""
    collection = json.loads((ROOT / "public" / "geo" / "bd-districts.geojson").read_text(encoding="utf-8"))
    points = []
    for feature in collection["features"]:
        rings = [polygon[0] for polygon in _polygons(feature["geometry"])]
        _, lon, lat = max((_ring_area_centroid(ring) for ring in rings), key=lambda t: t[0])
        points.append({
            "district_name": feature["properties"]["ADM2_EN"],
            "division_name": feature["properties"]["ADM1_EN"],
            "lat": round(lat, 4),
            "lon": round(lon, 4),
        })
    return sorted(points, key=lambda p: p["district_name"])
