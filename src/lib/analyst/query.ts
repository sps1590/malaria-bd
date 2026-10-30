/**
 * Aggregate query builder. Identifiers and expressions come only from the constants in catalog.ts;
 * every user-derived value (years, month numbers, place names, thresholds) is a bound parameter.
 */
import type { AreaSel } from "./areas";
import { metricOf, type GroupKey, type MetricDef } from "./catalog";
import { inlineSql, runReadOnly } from "./store";
import { plabel } from "./time";

export type Op = ">" | ">=" | "<" | "<=" | "=";
const OPS: ReadonlySet<string> = new Set([">", ">=", "<", "<=", "="]);

export interface AggQuery {
  metrics: MetricDef[];
  group: GroupKey;
  /** Union of areas; empty = all Bangladesh. */
  areas: AreaSel[];
  from: number;
  to: number;
  months?: number[];
  having?: { metric: MetricDef; op: Op; value: number }[];
  /** Minimum-denominator guards for ratio rankings, e.g. at least 100 tests before a positivity rate counts. */
  guards?: { expr: string; min: number }[];
  order?: { by: "group" | MetricDef; dir: "asc" | "desc" };
  limit?: number;
  /** Average of the monthly totals instead of the sum (additive metrics only). */
  avgMonthly?: boolean;
}

const GROUP_SQL: Record<GroupKey, string | null> = {
  none: null,
  year: "m.report_year::int",
  quarter: "(m.report_year * 10 + (m.report_month - 1) / 3 + 1)::int",
  month: "(m.report_year * 100 + m.report_month)::int",
  calmonth: "m.report_month::int",
  division: "m.division_name",
  district: "m.district_name",
  upazila: "(m.upazila_name || ' (' || m.district_name || ')')",
};

/** Parameterised WHERE fragment (over alias m) restricting to a union of areas. */
export function areaWhere(areas: AreaSel[], ph: (v: unknown, cast: string) => string): string {
  const conds = areas.map((a) => {
    if (a.level === "division") return `m.division_name = ${ph(a.division, "text")}`;
    if (a.level === "upazila") return `m.upazila_id IN (${(a.upazilaIds ?? []).map((id) => ph(id, "int")).join(", ")})`;
    return `m.district_name IN (${(a.districts ?? []).map((d) => ph(d, "text")).join(", ")})`;
  });
  return `(${conds.join(" OR ")})`;
}

export const PERIOD = "(m.report_year * 12 + m.report_month - 1)";

export function buildAgg(q: AggQuery): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const ph = (v: unknown, cast: string) => {
    params.push(v);
    return `$${params.length}::${cast}`;
  };

  const where = [`${PERIOD} BETWEEN ${ph(q.from, "int")} AND ${ph(q.to, "int")}`];
  if (q.months?.length) where.push(`m.report_month IN (${q.months.map((m) => ph(m, "int")).join(", ")})`);
  if (q.areas.length) where.push(areaWhere(q.areas, ph));

  const needsPop = q.metrics.some((m) => m.needsPop) || (q.having ?? []).some((h) => h.metric.needsPop);
  const from = `FROM mis_monthly m${needsPop ? "\n  LEFT JOIN upazila_population p ON p.upazila_id = m.upazila_id AND p.year = m.report_year" : ""}`;
  const g = GROUP_SQL[q.group];
  const alias = (m: MetricDef) => `m_${m.key}`;

  // ----- average of monthly totals (two-level)
  if (q.avgMonthly && q.metrics.every((m) => m.inner)) {
    const inner = q.metrics.map((m, i) => `sum(${m.inner}) AS v${i}`).join(", ");
    const outer = q.metrics.map((m, i) => `(avg(v${i}))::float8 AS ${alias(m)}`).join(", ");
    const having = (q.having ?? [])
      .filter((h) => OPS.has(h.op))
      .map((h) => {
        const i = q.metrics.findIndex((m) => m.key === h.metric.key);
        return i < 0 ? null : `avg(v${i}) ${h.op} ${ph(h.value, "float8")}`;
      })
      .filter(Boolean) as string[];
    const order = q.order?.by && q.order.by !== "group" ? `ORDER BY ${alias(q.order.by)} ${q.order.dir === "asc" ? "ASC" : "DESC"} NULLS LAST${g ? ", g" : ""}` : g ? "ORDER BY g" : "";
    const text = `SELECT ${g ? "g, " : ""}${outer}
FROM (
  SELECT ${g ? `${g} AS g, ` : ""}${PERIOD} AS pp, ${inner}
  ${from}
  WHERE ${where.join("\n    AND ")}
  GROUP BY ${g ? "1, 2" : "1"}
) x
${g ? "GROUP BY g" : ""}
${having.length ? `HAVING ${having.join(" AND ")}` : ""}
${order}
${q.limit ? `LIMIT ${ph(Math.min(Math.max(1, Math.floor(q.limit)), 5000), "int")}` : ""}`;
    return { text, params };
  }

  // ----- plain aggregate
  const select = q.metrics.map((m) => `${m.expr} AS ${alias(m)}`).join(",\n       ");
  const having = (q.having ?? [])
    .filter((h) => OPS.has(h.op))
    .map((h) => `${h.metric.expr} ${h.op} ${ph(h.value, "float8")}`);
  for (const gd of q.guards ?? []) having.push(`${gd.expr} >= ${ph(gd.min, "float8")}`);
  const order = q.order?.by && q.order.by !== "group" ? `ORDER BY ${alias(q.order.by)} ${q.order.dir === "asc" ? "ASC" : "DESC"} NULLS LAST${g ? ", g" : ""}` : g ? "ORDER BY g" : "";
  const text = `SELECT ${g ? `${g} AS g,\n       ` : ""}${select}
${from}
WHERE ${where.join("\n  AND ")}
${g ? "GROUP BY 1" : ""}
${having.length ? `HAVING ${having.join(" AND ")}` : ""}
${order}
${q.limit ? `LIMIT ${ph(Math.min(Math.max(1, Math.floor(q.limit)), 5000), "int")}` : ""}`;
  return { text, params };
}

export interface AggRow {
  g: string | number | null;
  [metric: string]: string | number | null;
}

export interface RunLog {
  sql: string[];
  ms: number;
  rows: number;
}
export const newLog = (): RunLog => ({ sql: [], ms: 0, rows: 0 });

export async function runAgg(q: AggQuery, log: RunLog, note?: string): Promise<AggRow[]> {
  const { text, params } = buildAgg(q);
  const res = await runReadOnly<Record<string, unknown>>(text, params);
  const window = `-- window: ${plabel(q.from)} – ${plabel(q.to)} (month index = year × 12 + month − 1)`;
  log.sql.push(`${note ? `-- ${note}\n` : ""}${window}\n${inlineSql(text, params)}`);
  log.ms += res.ms;
  log.rows += res.rows.length;
  return res.rows.map((r) => {
    const row: AggRow = { g: (r.g as string | number | null | undefined) ?? null };
    for (const m of q.metrics) {
      const v = r[`m_${m.key}`];
      row[m.key] = v === null || v === undefined ? null : Number(v);
    }
    return row;
  });
}

/** Run a raw, hand-written (constant) SELECT through the same read-only path and log it. */
export async function runFixed<T = Record<string, unknown>>(text: string, params: unknown[], log: RunLog, note?: string): Promise<T[]> {
  const res = await runReadOnly<T>(text, params);
  log.sql.push(`${note ? `-- ${note}\n` : ""}${inlineSql(text, params)}`);
  log.ms += res.ms;
  log.rows += res.rows.length;
  return res.rows;
}

export { metricOf };
