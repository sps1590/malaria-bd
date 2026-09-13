// Builds public/geo/bd-{divisions,districts,upazilas}.geojson from geoBoundaries
// (gbOpen BGD ADM1–3, simplified). geoBoundaries has no parent attributes, so each
// district/upazila is assigned to its parent by point-in-polygon voting.
// Usage: npm run geo:prepare
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/BGD";
const SRC_DIR = path.resolve("data/geo-src");
const OUT_DIR = path.resolve("public/geo");

async function load(level) {
  const file = path.join(SRC_DIR, `geoBoundaries-BGD-${level}_simplified.geojson`);
  if (!existsSync(file)) {
    const res = await fetch(`${BASE}/${level}/geoBoundaries-BGD-${level}_simplified.geojson`);
    if (!res.ok) throw new Error(`Download ${level} failed: HTTP ${res.status}`);
    await mkdir(SRC_DIR, { recursive: true });
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(await readFile(file, "utf8"));
}

const polygonsOf = (g) => (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []);

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (pt, rings) => inRing(pt, rings[0]) && !rings.slice(1).some((h) => inRing(pt, h));
const inGeometry = (pt, g) => polygonsOf(g).some((p) => inPolygon(pt, p));

function bbox(g) {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polygonsOf(g)) for (const [x, y] of p[0]) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// Interior sample points: a 14×14 grid over the bbox, kept where it falls inside the shape.
function samplePoints(g, grid = 14) {
  const [minX, minY, maxX, maxY] = bbox(g);
  const pts = [];
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const pt = [minX + ((i + 0.5) * (maxX - minX)) / grid, minY + ((j + 0.5) * (maxY - minY)) / grid];
      if (inGeometry(pt, g)) pts.push(pt);
    }
  }
  return pts.length >= 3 ? pts : vertexPoints(g);
}

// Fallback for thin shapes: outer-ring vertices pulled 15% toward the polygon's vertex centroid.
function vertexPoints(g, max = 80) {
  const pts = [];
  for (const p of polygonsOf(g)) {
    const ring = p[0];
    const cx = ring.reduce((s, [x]) => s + x, 0) / ring.length;
    const cy = ring.reduce((s, [, y]) => s + y, 0) / ring.length;
    pts.push([cx, cy], ...ring.map(([x, y]) => [x + 0.15 * (cx - x), y + 0.15 * (cy - y)]));
  }
  const step = Math.max(1, Math.floor(pts.length / max));
  return pts.filter((_, i) => i % step === 0);
}

function assignParent(child, parents) {
  const votes = new Map();
  for (const pt of samplePoints(child.geometry)) {
    for (const parent of parents) {
      const [a, b, c, d] = parent.bbox;
      if (pt[0] < a || pt[0] > c || pt[1] < b || pt[1] > d) continue;
      if (inGeometry(pt, parent.feature.geometry)) votes.set(parent, (votes.get(parent) ?? 0) + 1);
    }
  }
  let best = null;
  for (const [parent, n] of votes) if (!best || n > best[1]) best = [parent, n];
  return best?.[0] ?? null;
}

const round = (v) => (Array.isArray(v) ? v.map(round) : Math.round(v * 1e5) / 1e5);
const cleanName = (s) => String(s ?? "").replace(/\s+(Division|District|Zila|Upazila)$/i, "").trim();
const feature = (f, properties) => ({ type: "Feature", properties, geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) } });

const [adm1, adm2, adm3] = await Promise.all(["ADM1", "ADM2", "ADM3"].map(load));

const divisions = adm1.features.map((f) => ({ feature: f, bbox: bbox(f.geometry), name: cleanName(f.properties.shapeName) }));
const districts = adm2.features.map((f) => {
  const parent = assignParent(f, divisions);
  return { feature: f, bbox: bbox(f.geometry), name: cleanName(f.properties.shapeName), division: parent?.name ?? "" };
});
const upazilas = adm3.features.map((f) => {
  const parent = assignParent(f, districts);
  return { name: cleanName(f.properties.shapeName), district: parent?.name ?? "", division: parent?.division ?? "", feature: f };
});

await mkdir(OUT_DIR, { recursive: true });
const write = (file, features) =>
  writeFile(path.join(OUT_DIR, file), JSON.stringify({ type: "FeatureCollection", features }));

await write("bd-divisions.geojson", divisions.map((d) => feature(d.feature, { ADM1_EN: d.name })));
await write("bd-districts.geojson", districts.map((d) => feature(d.feature, { ADM2_EN: d.name, ADM1_EN: d.division })));
await write("bd-upazilas.geojson", upazilas.map((u) => feature(u.feature, { ADM3_EN: u.name, ADM2_EN: u.district, ADM1_EN: u.division })));

const orphans = [...districts, ...upazilas].filter((x) => !(x.division || x.district));
console.log(`divisions=${divisions.length} districts=${districts.length} upazilas=${upazilas.length} unassigned=${orphans.length}`);
if (orphans.length) console.log("Unassigned:", orphans.map((o) => o.name).join(", "));
