import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as { misSql?: Sql };

/** Shared pooled connection for server components and route handlers. */
export function getSql(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  globalForDb.misSql ??= postgres(url, { max: 5, prepare: false, idle_timeout: 20, onnotice: () => {} });
  return globalForDb.misSql;
}

export async function tableExists(sql: Sql, table: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`SELECT to_regclass(${table}) IS NOT NULL AS ok`;
  return row.ok;
}
