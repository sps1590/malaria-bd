import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as { misSql?: Sql };

/** Connection string: DATABASE_URL, or the Vercel/Neon integration's DATABASE_POSTGRES_URL. */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.DATABASE_POSTGRES_URL || process.env.POSTGRES_URL;
}

/** Shared pooled connection for server components and route handlers. */
export function getSql(): Sql {
  const url = databaseUrl();
  if (!url) throw new Error("DATABASE_URL is not set.");
  globalForDb.misSql ??= postgres(url, { max: 5, prepare: false, idle_timeout: 20, onnotice: () => {} });
  return globalForDb.misSql;
}

export async function tableExists(sql: Sql, table: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`SELECT to_regclass(${table}) IS NOT NULL AS ok`;
  return row.ok;
}
