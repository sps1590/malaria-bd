/** Wire types shared by the analyst API route and the chat UI (no server-only imports). */

export type Cell = string | number | null;
export type CellFormat = "int" | "d1" | "d2" | "pct1" | "pct2" | "signed_pct" | "text";

export interface TableColumn {
  key: string;
  label: string;
  format?: CellFormat;
}

export interface TableSpec {
  columns: TableColumn[];
  rows: Record<string, Cell>[];
}

export interface ChartSpec {
  kind: "line" | "bar" | "hbar";
  title: string;
  xKey: string;
  series: { key: string; label: string }[];
  rows: Record<string, Cell>[];
  format: "int" | "d1" | "d2" | "pct1" | "pct2";
}

/** What the next question may inherit ("and deaths?", "what about Bandarban?", "by district"). */
export interface AnalystContext {
  intent: string;
  metrics: string[];
  /** AreaSel refs, e.g. "district:Bandarban" or "group:endemic". */
  areas: string[];
  time: { from: number; to: number; months?: number[]; label: string } | null;
  group: string | null;
}

export interface AnalystReply {
  kind: "answer" | "refusal" | "help" | "clarify" | "error";
  /** Markdown narrative. */
  text: string;
  table?: TableSpec;
  chart?: ChartSpec;
  /** Parameter-inlined SQL that was run (for the "how I got this" panel). */
  sql: string[];
  /** How the question was understood, as label/value chips. */
  interpretation: { label: string; value: string }[];
  suggestions: string[];
  context: AnalystContext | null;
  ms: number;
  rowCount: number;
}

/** Streamed to the client as newline-delimited JSON. */
export type AnalystEvent =
  | { t: "step"; label: string }
  | { t: "reply"; reply: AnalystReply }
  | { t: "error"; message: string };
